"""Read image results reach the next controller/Agent request as real media."""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
from PIL import Image

from app.agent.loop import Agent
from app.llm.base import AgentResult
from app.llm.events import StreamEvent, ToolCall
from app.llm.multimodal import to_anthropic_content, to_openai_responses_content
from app.tools.base import ToolRegistry
from app.tools.file_state import FileStateStore
from app.tools.files import register_file_tools
from tests.test_agent_loop import FakeBackend, RecordRenderer
from tests.test_agent_runtime_boundaries import env as shared_agent_env
from tests.test_agent_runtime_boundaries import runner

agent_env = shared_agent_env


@pytest.fixture(autouse=True)
def separate_cwd(tmp_path_factory, monkeypatch):
    monkeypatch.chdir(tmp_path_factory.mktemp("cwd"))


def setup_reads(tmp_path):
    picture = tmp_path / "local.png"
    Image.new("RGB", (40, 30), "blue").save(picture)
    text = tmp_path / "note.txt"
    text.write_text("a text file")
    tools = ToolRegistry()
    register_file_tools(tools, store=FileStateStore())
    calls = [ToolCall(id="picture", name="Read", arguments=json.dumps({"path": str(picture)})),
             ToolCall(id="text", name="Read", arguments=json.dumps({"path": str(text)}))]
    return picture, tools, calls


def assert_image_request(messages, picture):
    images = [(index, message) for index, message in enumerate(messages)
              if isinstance(message.get("content"), list)
              and any(block.get("type") == "image" for block in message["content"])]
    assert len(images) == 1
    index, message = images[0]
    tool_results = [(i, item) for i, item in enumerate(messages) if item.get("role") == "tool"]
    assert {item["tool_call_id"] for _, item in tool_results} == {"picture", "text"}
    assert all(i < index and isinstance(item["content"], str) for i, item in tool_results)
    assert message["role"] == "user"
    # The block points at the immutable Read snapshot of this picture.
    assert Path(message["content"][1]["path"]).read_bytes() == picture.read_bytes()
    assert "untrusted" in message["content"][0]["text"]
    assert "Browser" not in str(message)
    assert message["openbear_context_source"]["kind"] == "execution"
    assert "base64" not in json.dumps(messages, default=str)
    assert to_openai_responses_content(message["content"])[1]["type"] == "input_image"
    assert to_anthropic_content(message["content"])[1]["source"]["media_type"] == "image/png"


async def test_controller_read_images_arrive_after_all_tool_results(tmp_path):
    picture, tools, calls = setup_reads(tmp_path)
    backend = FakeBackend([
        [StreamEvent(kind="tool_call", tool_calls=calls),
         StreamEvent(kind="finish", finish_reason="tool_calls")],
        [StreamEvent(kind="content", text="done"), StreamEvent(kind="finish", finish_reason="stop")],
    ])
    result = await Agent(backend, tools, max_retries=0).run(
        [{"role": "user", "content": "Read the local image and text."}], RecordRenderer(), model="fake")
    assert result.text == "done"
    assert_image_request(backend.seen_convos[1], picture)


async def test_independent_agent_read_images_arrive_after_all_tool_results(agent_env, tmp_path):
    dao, definition, make_task = agent_env
    task_id = await make_task()
    picture, tools, calls = setup_reads(tmp_path)
    seen = []

    class Backend:
        protocol = "chat"

        async def complete(self, messages, **kwargs):
            seen.append(copy.deepcopy(messages))
            if len(seen) == 1:
                return AgentResult(tool_calls=calls, finish_reason="tool_calls")
            return AgentResult(text="done", finish_reason="stop")

    execution = runner(dao, definition, task_id, Backend(), tools)
    result = await execution.run()
    assert result["summary"] == "done"
    assert_image_request(seen[1], picture)
    assert not execution._pending_tool_images
