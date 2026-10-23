"""Local Read images, validation, and protocol payloads without a browser."""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path

import pytest
from PIL import Image

from app.llm.multimodal import (
    to_anthropic_content,
    to_openai_chat_content,
    to_openai_responses_content,
)
from app.tools.base import ToolRegistry, ToolRuntimeContext
from app.tools.file_state import FileStateStore
from app.tools.files import register_file_tools


@pytest.fixture(autouse=True)
def separate_cwd(tmp_path_factory, monkeypatch):
    # Read snapshots go under ./data/tool_artifacts; keep them out of the repo.
    cwd = tmp_path_factory.mktemp("cwd")
    monkeypatch.chdir(cwd)
    return cwd


def snapshot_dir(cwd):
    return cwd / "data" / "tool_artifacts" / "images" / "chat-0"


@pytest.fixture
def registry():
    tools = ToolRegistry()
    register_file_tools(tools, store=FileStateStore())
    return tools


@pytest.mark.parametrize("fmt,mime", [
    ("PNG", "image/png"), ("JPEG", "image/jpeg"),
    ("GIF", "image/gif"), ("WEBP", "image/webp"),
])
@pytest.mark.parametrize("filename", ["picture", "picture.bin", "picture.PNG"])
async def test_read_image_uses_content_type_and_preserves_original(registry, tmp_path, separate_cwd, fmt, mime, filename):
    picture = tmp_path / filename
    Image.new("RGB", (24, 16), "red").save(picture, format=fmt)
    original = picture.read_bytes()
    context = ToolRuntimeContext()
    outcome = await registry.dispatch_outcome("Read", json.dumps({"path": str(picture)}), context=context)
    assert outcome.business_success is True
    assert context.tool_outcome is outcome
    metadata = json.loads(outcome.content)
    assert metadata["imageInput"] is True
    assert metadata["mime_type"] == mime
    assert (metadata["width"], metadata["height"]) == (24, 16)
    assert metadata["size_bytes"] == len(original)
    [block] = outcome.images
    snapshot = Path(block["path"])
    assert block == {"type": "image", "path": str(snapshot), "mime_type": mime, "name": filename}
    assert snapshot.parent == snapshot_dir(separate_cwd)
    assert snapshot.read_bytes() == original
    assert "base64" not in outcome.content
    assert picture.read_bytes() == original
    assert list(tmp_path.iterdir()) == [picture]

    chat = to_openai_chat_content(outcome.images)[0]["image_url"]["url"]
    responses = to_openai_responses_content(outcome.images)[0]["image_url"]
    anthropic = to_anthropic_content(outcome.images)[0]["source"]
    assert chat == responses
    assert chat.startswith(f"data:{mime};base64,")
    assert base64.b64decode(chat.split(",", 1)[1]) == original
    assert anthropic["media_type"] == mime
    assert base64.b64decode(anthropic["data"]) == original


async def test_images_are_returned_on_every_read_without_leaking_to_text(registry, tmp_path):
    picture = tmp_path / "picture.png"
    Image.new("RGB", (8, 8)).save(picture)
    text = tmp_path / "a.txt"
    text.write_text("alpha\nbeta\ngamma\n")
    context = ToolRuntimeContext()
    for args in ({}, {}, {"force": True}, {"offset": 1, "limit": 1}):
        outcome = await registry.dispatch_outcome(
            "Read", json.dumps({"path": str(picture), **args}), context=context)
        assert len(outcome.images) == 1
        assert json.loads(outcome.content)["imageInput"] is True
    for args in ({}, {"force": True}, {"offset": 1, "limit": 1}):
        outcome = await registry.dispatch_outcome(
            "Read", json.dumps({"path": str(text), **args}), context=context)
        assert outcome.images == []
        assert "beta" in outcome.content
    second = await registry.dispatch_outcome(
        "Read", json.dumps({"path": str(text), "offset": 1, "limit": 1}), context=context)
    assert "文件未变化" in second.content


async def test_relative_and_symlink_images(registry, tmp_path, monkeypatch):
    picture = tmp_path / "actual.png"
    Image.new("RGB", (8, 8)).save(picture)
    link = tmp_path / "alias"
    link.symlink_to(picture)
    monkeypatch.chdir(tmp_path)
    outcome = await registry.dispatch_outcome("Read", '{"path":"alias"}')
    assert Path(outcome.images[0]["path"]).read_bytes() == picture.read_bytes()
    assert json.loads(outcome.content)["path"] == str(link)


async def test_history_keeps_the_image_as_read_after_original_changes(registry, tmp_path, separate_cwd):
    picture = tmp_path / "shot.png"
    Image.new("RGB", (8, 8), "red").save(picture)
    first = await registry.dispatch_outcome("Read", json.dumps({"path": str(picture)}))
    again = await registry.dispatch_outcome("Read", json.dumps({"path": str(picture)}))
    seen = picture.read_bytes()
    # Same content is stored once; the block is identical on every later request.
    assert again.images == first.images
    snapshot = Path(first.images[0]["path"])
    Image.new("RGB", (8, 8), "blue").save(picture)
    changed = await registry.dispatch_outcome("Read", json.dumps({"path": str(picture)}))
    assert changed.images[0]["path"] != str(snapshot)
    picture.unlink()
    assert snapshot.read_bytes() == seen
    anthropic = to_anthropic_content(first.images)[0]["source"]
    assert base64.b64decode(anthropic["data"]) == seen
    assert sorted(p.name.startswith(".") for p in snapshot_dir(separate_cwd).iterdir()) == [False, False]


@pytest.mark.parametrize("filename,content", [
    ("fake.png", b"not an image"),
    ("cut.bin", b"\x89PNG\r\n\x1a\n"),
    ("cut.jpg", b"\xff\xd8\xff"),
])
async def test_invalid_images_never_enter_model_input(registry, tmp_path, filename, content):
    picture = tmp_path / filename
    picture.write_bytes(content)
    outcome = await registry.dispatch_outcome("Read", json.dumps({"path": str(picture)}))
    assert "图片无效" in outcome.content
    assert not outcome.images


async def test_truncated_jpeg_is_rejected(registry, tmp_path):
    picture = tmp_path / "cut.jpg"
    Image.new("RGB", (100, 100)).save(picture)
    picture.write_bytes(picture.read_bytes()[:-30])
    outcome = await registry.dispatch_outcome("Read", json.dumps({"path": str(picture)}))
    assert "图片无效" in outcome.content
    assert not outcome.images


async def test_oversized_image_is_rejected_before_decode(registry, tmp_path, monkeypatch):
    from app.tools import file_images

    picture = tmp_path / "large.png"
    Image.new("RGB", (8, 8)).save(picture)
    monkeypatch.setattr(file_images, "MAX_IMAGE_BYTES", picture.stat().st_size - 1)
    monkeypatch.setattr(Image, "open", lambda *a, **k: pytest.fail("must not decode oversized input"))
    outcome = await registry.dispatch_outcome("Read", json.dumps({"path": str(picture)}))
    assert "20 MiB" in outcome.content
    assert not outcome.images


async def test_pixel_bomb_is_rejected(registry, tmp_path, monkeypatch):
    picture = tmp_path / "large.png"
    Image.new("RGB", (8, 8)).save(picture)
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 40)
    outcome = await registry.dispatch_outcome("Read", json.dumps({"path": str(picture)}))
    assert "像素数过大" in outcome.content
    assert not outcome.images


@pytest.mark.parametrize("kind", ["fifo", "symlink_fifo", "directory", "missing", "binary"])
async def test_non_image_file_safety_is_preserved(registry, tmp_path, kind):
    path = tmp_path / "input.png"
    if kind in {"fifo", "symlink_fifo"}:
        fifo = tmp_path / "pipe"
        os.mkfifo(fifo)
        if kind == "symlink_fifo":
            path.symlink_to(fifo)
        else:
            path = fifo
    elif kind == "directory":
        path.mkdir()
    elif kind == "binary":
        path = tmp_path / "archive.zip"
        path.write_bytes(b"PK\x03\x04\x00")
    outcome = await registry.dispatch_outcome("Read", json.dumps({"path": str(path)}))
    assert outcome.content.startswith("error:")
    assert not outcome.images
    expected = {"fifo": "FIFO", "symlink_fifo": "FIFO", "directory": "目录", "missing": "不存在", "binary": "二进制"}
    assert expected[kind] in outcome.content


def test_schema_explains_vision_and_text_only_options(registry):
    schema = next(item for item in registry.schemas() if item["name"] == "Read")
    assert "vision input" in schema["description"]
    assert "20 MiB" in schema["description"]
    assert "图片不适用" in schema["parameters"]["properties"]["offset"]["description"]
