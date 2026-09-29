"""Concrete regressions found by the 2026-09-29 direct review."""
import json

import pytest

from app.agent.native_continuation import deserialize_messages, serialize_messages
from app.llm.anthropic import AnthropicBackend, _to_anthropic
from app.llm.base import OpenBearLLMError, aggregate
from app.llm.openai_responses import OpenAIResponsesBackend
from tests.conftest import make_client, sse_response


def message(item_id, texts):
    return {'type': 'message', 'id': item_id, 'role': 'assistant', 'status': 'completed',
            'content': [{'type': 'output_text', 'text': text} for text in texts]}


def event(kind, **fields):
    return {'type': kind, **fields}


def client_for(events, named=True):
    lines = []
    for item in events:
        if named:
            lines.append('event: ' + item['type'])
        lines.extend(['data: ' + json.dumps(item), ''])
    return make_client(lambda _: sse_response(lines))


@pytest.mark.parametrize('count', [2, 3, 4])
@pytest.mark.parametrize('completion', ['item', 'terminal'])
@pytest.mark.parametrize('named', [True, False])
async def test_all_parts_consume_deltas_before_full_snapshot(count, completion, named):
    texts = list('ABCD'[:count])
    output = message('m', [text * 2 for text in texts])
    events = [event('response.output_item.added', output_index=0, item={**output, 'content': []})]
    events += [event('response.output_text.delta', output_index=0, item_id='m', content_index=i, delta=t)
               for i, t in enumerate(texts)]
    if completion == 'item':
        events.append(event('response.output_item.done', output_index=0, item=output))
    events.append(event('response.completed', response={'status': 'completed', 'output': [output]}))
    client = client_for(events, named)
    try:
        backend = OpenAIResponsesBackend(client, 'https://offline.test', 'offline')
        result = await aggregate(backend.stream([], model='x', native_continuation=True))
        assert result.text == ''.join(t * 2 for t in texts)
        assert result.native_output_items == [output]
    finally:
        await client.close()


async def test_deferred_whole_item_done_closes_each_part_before_next_output():
    first, second, third = message('a', ['AA']), message('b', ['BB', 'CC', 'DD']), message('c', ['E'])
    events = [event('response.output_text.delta', output_index=0, item_id='a', content_index=0, delta='A')]
    events += [event('response.output_text.delta', output_index=1, item_id='b', content_index=i, delta=t)
               for i, t in enumerate('BCD')]
    events += [event('response.output_item.done', output_index=1, item=second),
               event('response.output_text.delta', output_index=2, item_id='c', content_index=0, delta='E'),
               event('response.output_item.done', output_index=0, item=first),
               event('response.completed', response={'status': 'completed', 'output': [first, second, third]})]
    client = client_for(events)
    try:
        result = await aggregate(OpenAIResponsesBackend(client, 'https://offline.test', 'offline').stream([], model='x'))
        assert result.text == 'AABBCCDDE'
    finally:
        await client.close()


async def test_eof_with_deferred_output_is_an_error_not_a_successful_partial_result():
    events = [event('response.output_text.delta', output_index=i, item_id=f'm{i}', content_index=0, delta=t)
              for i, t in enumerate('AB')]
    client = client_for(events)
    received = []
    try:
        with pytest.raises(OpenBearLLMError, match='流提前结束'):
            async for output in OpenAIResponsesBackend(client, 'https://offline.test', 'offline').stream([], model='x'):
                received.append(output)
        assert ''.join(e.text for e in received if e.kind == 'content') == 'A'
        assert not any(e.kind in {'finish', 'tool_call', 'native_output_item'} for e in received)
    finally:
        await client.close()


async def test_first_delta_is_immediate_and_done_only_eof_preserves_content_as_interrupted():
    class Client:
        consumed = 0
        async def post_sse(self, *args, **kwargs):
            self.consumed += 1
            yield '', event('response.output_text.delta', output_index=0, item_id='m', content_index=0, delta='A')
            self.consumed += 1
            yield '', event('response.output_item.done', output_index=0, item=message('m', ['A']))
    client = Client()
    stream = OpenAIResponsesBackend(client, 'https://offline.test', 'offline').stream([], model='x')
    first = await anext(stream)
    assert first.kind == 'content' and first.text == 'A' and client.consumed == 1
    rest = []
    with pytest.raises(OpenBearLLMError, match='未收到响应终态'):
        async for e in stream:
            rest.append(e)
    assert not any(e.kind in {'content', 'finish'} for e in rest)


async def test_claude_citation_deltas_survive_serialization_and_outbound_native_replay():
    citations = [{'type': 'char_location', 'cited_text': text, 'document_index': 0,
                  'document_title': 'source', 'start_char_index': i * 5, 'end_char_index': i * 5 + 4,
                  'provider_extension': {'keep': True}} for i, text in enumerate(['Blue', 'sky'])]
    events = [event('content_block_start', index=0, content_block={'type': 'text', 'text': '', 'citations': None}),
              event('content_block_delta', index=0, delta={'type': 'text_delta', 'text': 'Blue sky.'})]
    events += [event('content_block_delta', index=0, delta={'type': 'citations_delta', 'citation': cite}) for cite in citations]
    events += [event('content_block_stop', index=0), event('message_delta', delta={'stop_reason': 'end_turn'}), event('message_stop')]
    client = client_for(events)
    try:
        result = await aggregate(AnthropicBackend(client, 'https://offline.test', 'offline').stream([], model='claude'))
        expected = [{'type': 'text', 'text': 'Blue sky.', 'citations': citations}]
        assert result.native_output_items == expected
        restored = deserialize_messages(serialize_messages([{'role': 'assistant', 'content': result.text,
                                                              'native_output_items': result.native_output_items}]))
        assert _to_anthropic(restored)[0]['content'] == expected
    finally:
        await client.close()
