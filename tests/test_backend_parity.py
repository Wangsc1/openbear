"""三协议一致性测试 —— 同一请求级 overlay 在 chat/responses/anthropic 三种 payload 中一致落位。"""
from __future__ import annotations

from app.llm.anthropic import AnthropicBackend
from app.llm.openai_chat import OpenAIChatBackend
from app.llm.openai_responses import OpenAIResponsesBackend
from app.task_memory import inject_runtime_block_into_latest_user


def test_request_local_xml_user_overlay_reaches_all_three_protocol_payloads():
    xml = '<openbear-memory-checkpoint version="1"><instructions>save state</instructions></openbear-memory-checkpoint>'
    canonical = [{"role": "user", "content": "latest user request"}]
    outbound = inject_runtime_block_into_latest_user(canonical, xml)
    backends = (
        OpenAIChatBackend(None, "https://x/v1", "k"),
        AnthropicBackend(None, "https://x/v1", "k"),
        OpenAIResponsesBackend(None, "https://x/v1", "k"),
    )

    for backend in backends:
        payload = backend.build_payload(outbound, model="m", system="stable system")
        assert xml in str(payload)
        assert xml not in str(payload.get("system") or payload.get("instructions") or "")
    assert canonical == [{"role": "user", "content": "latest user request"}]
