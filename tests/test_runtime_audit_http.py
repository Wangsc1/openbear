import asyncio
from contextlib import asynccontextmanager

import pytest

from app.llm.client import HTTPClient
from app.llm.base import OpenBearLLMError


@pytest.mark.parametrize('phase', ['headers', 'error_body'])
@pytest.mark.parametrize('total', [0, .015])
async def test_sse_stalls_before_data_are_bounded_and_closed(phase, total):
    client = HTTPClient(timeout_s=.03, total_timeout_s=total)
    closed = asyncio.Event()
    class Response:
        status_code = 503
        headers = {}
        async def aread(self):
            await asyncio.Event().wait()
    @asynccontextmanager
    async def stream(*args, **kwargs):
        try:
            timeout = kwargs['timeout']
            assert timeout.pool is not None and timeout.write is not None
            if phase == 'headers':
                await asyncio.Event().wait()
            yield Response()
        finally:
            closed.set()
    client._http.stream = stream
    async def drain():
        async for _ in client.post_sse('http://unused.invalid', {}, {}):
            pass
    try:
        with pytest.raises(OpenBearLLMError) as exc:
            await asyncio.wait_for(drain(), .2)
        assert exc.value.retryable and '超时' in str(exc.value)
        assert closed.is_set()
    finally:
        await client.close()
