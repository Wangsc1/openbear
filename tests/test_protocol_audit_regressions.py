"""Protocol regression cases from the 2026-09-29 wire audit (offline HTTP)."""
import json

import httpx
import pytest

from app.llm.base import OpenBearLLMError, aggregate
from app.llm.openai_responses import OpenAIResponsesBackend
from app.llm.openai_chat import OpenAIChatBackend
from app.llm.anthropic import AnthropicBackend
from app.llm.retry import RetryPolicy
from app.runtime.model_call import ModelCallDriver, PreparedRequest, execute_attempt
from tests.conftest import make_client

MESSAGE = {'id': 'msg1', 'type': 'message', 'role': 'assistant', 'status': 'completed',
           'content': [{'type': 'output_text', 'text': 'ready', 'annotations': []}]}
CALL = {'id': 'fc1', 'type': 'function_call', 'call_id': 'call1', 'name': 'Read',
        'arguments': '{"path":"a"}', 'status': 'completed'}


def frame(typ, **fields):
    return {'type': typ, **fields}


def backend(cls, events=None, *, obj=None, raw=None):
    if raw is None:
        raw = (''.join('data: ' + json.dumps(x) + '\n\n' for x in events).encode()
               if events is not None else json.dumps(obj).encode())
    return cls(make_client(lambda _: httpx.Response(200, content=raw)), 'https://offline.invalid/v1', 'fixture')


def request(b):
    return PreparedRequest(b, [{'role': 'user', 'content': 'read'}], {'model': 'fixture', 'native_continuation': True})


@pytest.mark.parametrize('terminal', [[], [MESSAGE], [MESSAGE, CALL]])
async def test_responses_terminal_never_discards_finalized_call(terminal):
    b = backend(OpenAIResponsesBackend, [
        frame('response.output_item.done', output_index=0, item=MESSAGE),
        frame('response.output_item.done', output_index=1, item=CALL),
        frame('response.completed', response={'status': 'completed', 'output': terminal}),
    ])
    result = await aggregate(b.stream([], model='fixture', native_continuation=True))
    assert result.text == 'ready'
    assert result.finish_reason == 'tool_calls'
    assert [x.id for x in result.tool_calls] == ['call1']
    assert result.native_output_items == [MESSAGE, CALL]


@pytest.mark.parametrize('stream', [True, False])
async def test_responses_incomplete_cannot_be_executable(stream):
    obj = {'status': 'incomplete', 'incomplete_details': {'reason': 'max_output_tokens'},
           'output': [{**CALL, 'status': 'incomplete'}]}
    b = backend(OpenAIResponsesBackend, [frame('response.incomplete', response=obj)] if stream else None, obj=obj)
    result = await aggregate(b.stream([], model='fixture')) if stream else await b.complete([], model='fixture')
    assert result.finish_reason == 'length'
    assert result.tool_calls == []


@pytest.mark.parametrize('cls', [OpenAIResponsesBackend, OpenAIChatBackend])
@pytest.mark.parametrize('stream', [True, False])
async def test_refusal_is_visible(cls, stream):
    if cls is OpenAIResponsesBackend:
        obj = {'status': 'completed', 'output': [{**MESSAGE, 'content': [{'type': 'refusal', 'refusal': 'Cannot comply.'}]}]}
        events = [frame('response.refusal.delta', output_index=0, content_index=0, item_id='msg1', delta='Cannot '),
                  frame('response.refusal.done', output_index=0, content_index=0, item_id='msg1', refusal='Cannot comply.'),
                  frame('response.completed', response=obj)]
    else:
        obj = {'choices': [{'message': {'content': None, 'refusal': 'Cannot comply.'}, 'finish_reason': 'stop'}]}
        events = [{'choices': [{'delta': {'refusal': 'Cannot comply.'}, 'finish_reason': 'stop'}]}]
    b = backend(cls, events if stream else None, obj=obj)
    result = await aggregate(b.stream([], model='fixture')) if stream else await b.complete([], model='fixture')
    assert result.text == 'Cannot comply.'


@pytest.mark.parametrize('stream', [True, False])
async def test_chat_length_is_not_tool_calls(stream):
    call = {'index': 0, 'id': 'call1', 'type': 'function', 'function': {'name': 'Read', 'arguments': '{}'}}
    obj = {'choices': [{'message': {'tool_calls': [call]}, 'finish_reason': 'length'}]}
    events = [{'choices': [{'delta': {'tool_calls': [call]}, 'finish_reason': 'length'}]}]
    b = backend(OpenAIChatBackend, events if stream else None, obj=obj)
    result = await aggregate(b.stream([], model='fixture')) if stream else await b.complete([], model='fixture')
    assert result.finish_reason == 'length'
    assert result.tool_calls == []


@pytest.mark.parametrize('cls,events', [
    (OpenAIResponsesBackend, [frame('response.output_item.done', output_index=0, item=MESSAGE)]),
    (OpenAIChatBackend, [{'choices': [{'delta': {'content': 'partial'}}]}]),
    (AnthropicBackend, [frame('content_block_start', index=0, content_block={'type': 'text', 'text': ''}),
                        frame('content_block_delta', index=0, delta={'type': 'text_delta', 'text': 'partial'})]),
])
async def test_eof_without_completion_is_recoverable_not_success(cls, events):
    result = await execute_attempt(request(backend(cls, events)))
    assert result.status == 'error'
    assert result.error.retryable
    assert result.response.tool_calls == []
    assert result.response.text


async def test_finalized_responses_tool_on_eof_recovers_without_reissuing_request():
    b = backend(OpenAIResponsesBackend, [frame('response.output_item.done', output_index=0, item=CALL)])
    outcomes = []
    result = await ModelCallDriver(RetryPolicy(max_retries=0)).call(lambda tail: request(b), outcomes.append)
    assert result.recovered_tool_calls
    assert result.attempts == 1 and result.retries == 0
    assert result.response.finish_reason == 'tool_calls'
    assert [x.id for x in result.response.tool_calls] == ['call1']
    assert [x.status for x in outcomes] == ['error']


@pytest.mark.parametrize('nl', ['\n', '\r\n', '\r'])
async def test_sse_multiline_event_is_one_json_document(nl):
    obj = frame('response.completed', response={'status': 'completed', 'output': [CALL]})
    data = json.dumps(obj)
    split = data.index(',') + 1
    raw = ('event: response.completed' + nl + 'data: ' + data[:split] + nl + 'data: ' + data[split:] + nl + nl).encode()
    result = await aggregate(backend(OpenAIResponsesBackend, raw=raw).stream([], model='fixture'))
    assert [x.id for x in result.tool_calls] == ['call1']


@pytest.mark.parametrize('nl', ['\n', '\r\n', '\r'])
async def test_sse_unicode_content_and_utf8_byte_splits_are_not_line_boundaries(nl):
    from app.llm.client import HTTPClient
    text = '中\u0085\u2028\u2029文'
    obj = {'choices': [{'delta': {'content': text}, 'finish_reason': 'stop'}]}
    raw = ('data: ' + json.dumps(obj, ensure_ascii=False) + nl + nl).encode()
    class Bytes(httpx.AsyncByteStream):
        async def __aiter__(self):
            for value in raw:
                yield bytes([value])
    client = make_client(lambda _: httpx.Response(200, stream=Bytes()))
    try:
        result = await aggregate(OpenAIChatBackend(client, 'https://fixture.invalid/v1', 'fixture').stream([], model='fixture'))
        assert result.text == text
    finally:
        await client.close()


async def test_chat_semantic_finish_does_not_require_done_sentinel():
    events = [{'choices': [{'delta': {'tool_calls': [{'index': 0, 'id': 'call1', 'function': {'name': 'Read', 'arguments': '{}'}}]},
                            'finish_reason': 'stop'}]}]
    result = await aggregate(backend(OpenAIChatBackend, events).stream([], model='fixture'))
    assert result.finish_reason == 'tool_calls'
    assert len(result.tool_calls) == 1
