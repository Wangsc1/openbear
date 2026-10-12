from __future__ import annotations

import copy
import json

import pytest

from app.agent.loop import Agent
from app.agent.transcript_repair import (
    LEGACY_ROLE_ALTERNATION_BRIDGE_TEXT as LEGACY_MARKER,
)
from app.agent.transcript_repair import (
    ROLE_ALTERNATION_BRIDGE_TEXT as MARKER,
)
from app.llm.anthropic import _to_anthropic
from app.llm.events import StreamEvent, ToolCall, Usage
from app.llm.openai_responses import _to_responses_input
from app.tools.base import ToolRuntimeContext
from tests.test_agent_loop import FakeBackend, _echo_registry
from tests.test_tool_input_lifecycle import operations, presentation


class Persister:
    def __init__(self):
        self.assistants = []
        self.checkpoints = []
        self.tool_results = []

    async def save_assistant(self, **kwargs):
        self.assistants.append(copy.deepcopy(kwargs))

    async def save_native_context(self, *, messages):
        self.checkpoints.append(copy.deepcopy(messages))

    async def save_user(self, **kwargs):
        pass

    async def save_tool_result(self, **kwargs):
        self.tool_results.append(copy.deepcopy(kwargs))


def contents(text):
    return [StreamEvent('content', text=part) for part in text]


def answers(rows):
    return [row['payload'].get('text', '') for row in rows.values()
            if row['op_type'] == 'assistant_message']


@pytest.mark.parametrize('marker', [LEGACY_MARKER, MARKER])
@pytest.mark.parametrize('steering', [False, True])
@pytest.mark.parametrize('with_reasoning', [False, True])
async def test_fragmented_bridge_never_enters_web_frames_or_steering_timeline(
    presentation, steering, with_reasoning, marker,
):
    MARKER = marker
    renderer, db, events = presentation
    queued = []

    class Backend(FakeBackend):
        async def stream(self, messages, **kwargs):
            async for event in super().stream(messages, **kwargs):
                if self._round == 1 and event.kind == 'finish' and steering:
                    queued.append('new target')
                yield event

    def drain():
        result = queued[:]
        queued.clear()
        return result

    thought = [StreamEvent('reasoning', text='thinking')] if with_reasoning else []
    backend = Backend([
        [*contents(MARKER), *thought, StreamEvent('finish', finish_reason='stop')],
        [StreamEvent('content', text='real answer'), StreamEvent('finish', finish_reason='stop')],
    ])
    persister = Persister()
    result = await Agent(backend, _echo_registry(), empty_response_retry_limit=1,
                         reasoning_only_retry_limit=1).run(
        [{'role': 'user', 'content': 'fixture'}], renderer, model='fixture',
        show_thinking=True, steer_drain=drain, persister=persister,
    )
    assert result.text == 'real answer'
    assert result.model_calls == 2
    assert result.steered == int(steering)
    assert answers(await operations(db)) == ['real answer']
    visible = [event.get('text', '') for event in events if event['type'] in {'delta', 'cut', 'final'}]
    assert all('[protocol:' not in text for text in visible)
    assert MARKER not in json.dumps(persister.assistants)
    assert MARKER not in json.dumps(persister.checkpoints)


@pytest.mark.parametrize('marker', [LEGACY_MARKER, MARKER])
@pytest.mark.parametrize('protocol', ['anthropic', 'responses'])
@pytest.mark.parametrize('with_reasoning', [False, True])
async def test_exhausted_bridge_drops_whole_native_turn_and_cannot_replay(
    presentation, protocol, with_reasoning, marker,
):
    MARKER = marker
    renderer, db, events = presentation
    if protocol == 'anthropic':
        native = [{'type': 'text', 'text': MARKER}]
        if with_reasoning:
            native.insert(0, {'type': 'thinking', 'thinking': 'thought', 'signature': 'signed'})
    else:
        native = [{'type': 'message', 'role': 'assistant',
                   'content': [{'type': 'output_text', 'text': MARKER}]}]
        if with_reasoning:
            native.insert(0, {'type': 'reasoning', 'encrypted_content': 'opaque', 'summary': []})
    thought = [StreamEvent('reasoning', text='thought', signature='signed')] if with_reasoning else []
    backend = FakeBackend([[
        *thought, *contents(MARKER),
        StreamEvent('native_output_item', native_output_items=native),
        StreamEvent('usage', usage=Usage(input_tokens=5, output_tokens=7)),
        StreamEvent('finish', finish_reason='stop'),
    ]])
    backend.protocol = protocol
    persister = Persister()
    result = await Agent(backend, _echo_registry(), empty_response_retry_limit=1,
                         reasoning_only_retry_limit=1).run(
        [{'role': 'user', 'content': 'fixture'}], renderer, model='fixture',
        persister=persister, show_thinking=True,
    )
    assert '自动补救次数已用尽' in result.text
    assert result.halted_reason == 'empty_response'
    assert result.model_calls == 2
    assert persister.assistants[-1]['content'] == result.text
    assert answers(await operations(db)) == [result.text]
    assert result.usage.input_tokens == 10
    assert result.usage.output_tokens == 14
    assert all(not message['native_output_items'] and not message['signature']
               for message in persister.assistants)
    assert MARKER not in json.dumps(persister.assistants)
    assert MARKER not in json.dumps(persister.checkpoints)
    replay = _to_anthropic if protocol == 'anthropic' else _to_responses_input
    for checkpoint in persister.checkpoints:
        assert MARKER not in json.dumps(replay(checkpoint))
    assert all(MARKER not in text for text in answers(await operations(db)))


@pytest.mark.parametrize('text', [
    '[', '[protocol:', '[openbear internal',
    LEGACY_MARKER + ' is a protocol marker', MARKER + ' is a protocol marker',
])
@pytest.mark.parametrize('steering', [False, True])
async def test_held_prefix_and_normal_marker_mentions_are_not_lost(presentation, text, steering):
    renderer, db, _ = presentation
    queued = []

    class Backend(FakeBackend):
        async def stream(self, messages, **kwargs):
            async for event in super().stream(messages, **kwargs):
                if self._round == 1 and event.kind == 'finish' and steering:
                    queued.append('continue')
                yield event

    def drain():
        result = queued[:]
        queued.clear()
        return result

    backend = Backend([
        [*contents(text), StreamEvent('finish', finish_reason='stop')],
        [StreamEvent('content', text='next'), StreamEvent('finish', finish_reason='stop')],
    ])
    result = await Agent(backend, _echo_registry()).run(
        [{'role': 'user', 'content': 'fixture'}], renderer, model='fixture', steer_drain=drain,
    )
    assert result.text == ('next' if steering else text)
    assert result.model_retry == 0
    assert answers(await operations(db)) == ([text, 'next'] if steering else [text])


@pytest.mark.parametrize('text', [MARKER, '['])
async def test_stream_error_does_not_persist_bridge_or_discard_literal_prefix(presentation, text):
    renderer, db, _ = presentation
    backend = FakeBackend([[
        *contents(text), StreamEvent('error', error='fixture failure', retryable=False),
    ]])
    persister = Persister()
    await Agent(backend, _echo_registry(), max_retries=0).run(
        [{'role': 'user', 'content': 'fixture'}], renderer, model='fixture', persister=persister,
    )
    assert MARKER not in json.dumps(persister.assistants)
    assert MARKER not in json.dumps(await operations(db))
    if text != MARKER:
        assert persister.assistants[0]['content'] == text
        assert text in answers(await operations(db))


async def test_bridge_preface_with_real_tool_call_is_not_an_empty_response(presentation):
    renderer, db, _ = presentation
    backend = FakeBackend([
        [*contents(MARKER), StreamEvent('tool_call', tool_calls=[ToolCall('c', 'echo', '{"x":"ok"}')]),
         StreamEvent('finish', finish_reason='tool_calls')],
        [StreamEvent('content', text='done'), StreamEvent('finish', finish_reason='stop')],
    ])
    result = await Agent(backend, _echo_registry()).run(
        [{'role': 'user', 'content': 'fixture'}], renderer, model='fixture',
    )
    assert result.tools_used == ['echo']
    assert result.text == 'done'
    assert result.model_retry == 0
    assert MARKER in answers(await operations(db))


@pytest.mark.parametrize('marker', [LEGACY_MARKER, MARKER])
@pytest.mark.parametrize('after_tools', ['echo', 'answer'])
async def test_retry_then_tools_preserves_budget_pairing_and_real_answer(
    presentation, marker, after_tools,  # noqa: F811 -- imported pytest fixture
):
    renderer, db, events = presentation
    final = marker if after_tools == 'echo' else 'done after tools'
    backend = FakeBackend([
        [*contents(marker), StreamEvent('finish', finish_reason='stop')],
        [StreamEvent('tool_call', tool_calls=[ToolCall('c', 'echo', '{"x":"ok"}')]),
         StreamEvent('finish', finish_reason='tool_calls')],
        [*contents(final), StreamEvent('finish', finish_reason='stop')],
    ])
    persister = Persister()
    terminal = []

    async def terminal_policy(reason):
        terminal.append(reason)

    original = [{'role': 'user', 'content': 'fixture'},
                {'role': 'user', 'content': 'additional input'}]
    snapshot = copy.deepcopy(original)
    result = await Agent(backend, _echo_registry(), empty_response_retry_limit=1).run(
        original, renderer, model='fixture', persister=persister,
        tool_context=ToolRuntimeContext(terminal_policy=terminal_policy),
    )
    assert original == snapshot
    assert result.model_calls == 3
    assert result.model_retry == 1
    assert result.tools_used == ['echo']
    assert persister.tool_results[0]['tool_call_id'] == 'c'
    assert backend.seen_convos[1][:len(backend.seen_convos[0])] == backend.seen_convos[0]
    assert '不要复述' in backend.seen_convos[1][-1]['content']
    for convo in backend.seen_convos:
        wire = _to_anthropic(convo)
        assert all(a['role'] != b['role'] for a, b in zip(wire, wire[1:]))
    tool_turn = backend.seen_convos[2]
    call_index = next(i for i, m in enumerate(tool_turn) if m.get('tool_calls'))
    assert tool_turn[call_index + 1]['role'] == 'tool'
    assert tool_turn[call_index + 1]['tool_call_id'] == 'c'
    if after_tools == 'echo':
        assert '自动补救次数已用尽' in result.text
        assert result.halted_reason == 'empty_response'
        assert terminal == ['failed']
    else:
        assert result.text == final
        assert not result.halted_reason
        assert terminal == ['completed']
    assert persister.assistants[-1]['content'] == result.text
    assert answers(await operations(db)) == [result.text]
    assert all(marker not in event.get('text', '') for event in events
               if event['type'] in {'delta', 'cut', 'final'})


@pytest.mark.parametrize('reasoning', [False, True])
async def test_zero_recovery_budget_still_persists_explicit_failure(presentation, reasoning):  # noqa: F811 -- imported pytest fixture
    renderer, db, _ = presentation
    thought = [StreamEvent('reasoning', text='thinking')] if reasoning else []
    backend = FakeBackend([[*thought, StreamEvent('finish', finish_reason='stop')]])
    persister = Persister()
    result = await Agent(backend, _echo_registry(), empty_response_retry_limit=0,
                         reasoning_only_retry_limit=0).run(
        [{'role': 'user', 'content': 'fixture'}], renderer, model='fixture', persister=persister,
    )
    assert result.model_calls == 1
    assert result.model_retry == 0
    assert result.halted_reason == 'empty_response'
    assert '自动补救次数已用尽' in result.text
    assert persister.assistants[-1]['content'] == result.text
    assert answers(await operations(db)) == [result.text]
