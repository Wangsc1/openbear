"""Opt-in real model test: discover Read, inspect unseen pixels, answer correctly."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import os
import secrets

import pytest
from PIL import Image, ImageDraw, ImageFont

from app.agent.loop import Agent
from app.config import load_config
from app.llm.client import HTTPClient
from app.llm.factory import BackendFactory
from app.llm.image_limits import _content_lists, _inline_image, _patches, image_limits
from app.tools.base import ToolRegistry
from app.tools.file_state import FileStateStore
from app.tools.files import register_file_tools
from tests.test_agent_loop import RecordRenderer

pytestmark = pytest.mark.live
_MODELS = [name.strip() for name in os.environ.get("OPENBEAR_LIVE_IMAGE_MODELS", "").split(",") if name.strip()] or [""]


class ImageRenderer(RecordRenderer):
    def __init__(self):
        super().__init__()
        self.calls = []

    async def on_tool_result(self, tool_call_id, name, arguments, result, duration_ms):
        self.calls.append({"name": name, "arguments": json.loads(arguments), "result": json.loads(result)})


def visual_challenge(path, oversized=False):
    code = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(8))
    shapes = ["circle", "square", "triangle"]
    colors = ["red", "green", "blue"]
    rng = secrets.SystemRandom()
    rng.shuffle(shapes)
    rng.shuffle(colors)
    image = Image.new("RGB", (960, 420), "white")
    draw = ImageDraw.Draw(image)
    draw.text((70, 35), code, fill="black", font=ImageFont.load_default(size=60))
    expected = {"code": code}
    for position, x, shape, color in zip(("left", "middle", "right"), (170, 480, 790), shapes, colors, strict=True):
        if shape == "circle":
            draw.ellipse((x - 85, 180, x + 85, 350), fill=color)
        elif shape == "square":
            draw.rectangle((x - 85, 180, x + 85, 350), fill=color)
        else:
            draw.polygon([(x, 170), (x - 90, 350), (x + 90, 350)], fill=color)
        expected[position] = {"color": color, "shape": shape}
    if oversized:
        canvas = Image.new("RGB", (8800, 4000), "white")
        canvas.paste(image.resize((7680, 3360)), (0, 0))
        canvas.paste(Image.frombytes("RGB", (1400, 1000), secrets.token_bytes(4_200_000)), (7400, 3000))
        image = canvas
    image.save(path, quality=95)
    return expected


@pytest.mark.parametrize("fullname", _MODELS)
@pytest.mark.parametrize("oversized", [False, True], ids=["small", "oversized"])
async def test_live_model_reads_local_image_and_reports_pixels(tmp_path, fullname, oversized):
    config = load_config(os.environ.get("OPENBEAR_CONFIG") or None)
    fullname = fullname or config.models.primary
    resolved = config.models.resolve(fullname)
    if resolved is None:
        pytest.skip(f"model is not configured: {fullname}")
    provider, definition = resolved
    limits = image_limits(definition.id, provider.base_url, 1)
    if oversized and not (limits.max_dimension or limits.max_patches):
        pytest.skip(f"no documented oversize image policy for {fullname}")
    picture = tmp_path / ("visual-check.png" if oversized else "visual-check.jpg")
    expected = visual_challenge(picture, oversized=oversized)
    original_hash = hashlib.sha256(picture.read_bytes()).hexdigest()
    if oversized:
        assert 3_750_000 < picture.stat().st_size <= 20 * 1024 * 1024
    tools = ToolRegistry()
    register_file_tools(tools, store=FileStateStore())
    tools._tools = {"Read": tools._tools["Read"]}
    client = HTTPClient(first_byte_timeout_s=90, total_timeout_s=150)
    backend, model, _ = BackendFactory(config.models, client).backend_for(fullname)
    renderer = ImageRenderer()
    sent_images = []
    post_sse = client.post_sse

    async def record_images(url, headers, payload, **kwargs):
        for content in _content_lists(payload):
            for block in content:
                if not isinstance(block, dict):
                    continue
                inline = _inline_image(block)
                if inline is not None:
                    data = base64.b64decode(inline[0])
                    with Image.open(io.BytesIO(data)) as image:
                        sent_images.append({"size": image.size, "base64_bytes": len(inline[0]),
                                            "patches": _patches(image.size),
                                            "hash": hashlib.sha256(data).hexdigest()})
        async for event in post_sse(url, headers, payload, **kwargs):
            yield event

    client.post_sse = record_images
    try:
        result = await asyncio.wait_for(
            Agent(backend, tools, max_retries=0, max_run_wall_seconds=180).run(
                [{"role": "user", "content": (
                    f"查看本地图片 {picture}。只输出一个 JSON 对象，不加 Markdown："
                    "code 为图片顶部的字符串，left、middle、right 分别为从左到右的图形；"
                    "每个图形包含 color 和 shape，颜色用英文小写，形状用 circle、square 或 triangle。"
                    "必须根据图片回答，不能猜测。"
                )}], renderer, model=model, max_tokens=4096, think_level="low",
            ), timeout=210,
        )
    finally:
        await client.close()
    assert result.tools_used == ["Read"], {
        "tools": result.tools_used, "answer": result.text,
        "error": renderer.failed, "halted": result.halted_reason,
    }
    assert len(renderer.calls) == 1
    assert renderer.calls[0]["arguments"]["path"] == str(picture)
    assert renderer.calls[0]["result"]["imageInput"] is True
    actual = json.loads(result.text.strip())
    assert actual == expected, {"actual": actual, "expected": expected}
    assert hashlib.sha256(picture.read_bytes()).hexdigest() == original_hash
    assert sent_images
    if oversized:
        assert all(item["hash"] != original_hash for item in sent_images)
        if model.startswith("claude-"):
            assert all(item["base64_bytes"] <= 5_000_000 and max(item["size"]) <= 2000 for item in sent_images)
        elif model == "gpt-6-astra":
            assert all(item["patches"] <= 30_000 for item in sent_images)
    else:
        assert all(item["hash"] == original_hash for item in sent_images)
    print(json.dumps({"model": fullname, "protocol": backend.protocol, "oversized": oversized,
                      "rounds": result.rounds, "tools": result.tools_used,
                      "sent_images": [{k: v for k, v in item.items() if k != "hash"} for item in sent_images],
                      "answer": actual, "passed": True}, ensure_ascii=False))
