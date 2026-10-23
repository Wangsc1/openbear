from __future__ import annotations

import base64
import copy
import io
import json
import random

import pytest
from PIL import Image

from app.llm.anthropic import AnthropicBackend
from app.llm.base import OpenBearLLMError
from app.llm.image_limits import ImageLimits, _fit, _patches, image_limits, prepare_image, prepare_image_payload
from app.llm.openai_chat import OpenAIChatBackend
from app.llm.openai_responses import OpenAIResponsesBackend


def picture(size=(64, 32), fmt="PNG", mode="RGB"):
    out = io.BytesIO()
    Image.new(mode, size, "red").save(out, format=fmt)
    return out.getvalue()


def block(data, protocol="anthropic", mime="image/png", detail=None):
    encoded = base64.b64encode(data).decode()
    if protocol == "anthropic":
        return {"type": "image", "source": {"type": "base64", "media_type": mime, "data": encoded}}
    url = f"data:{mime};base64,{encoded}"
    if protocol == "chat":
        return {"type": "image_url", "image_url": {"url": url, **({"detail": detail} if detail else {})}}
    return {"type": "input_image", "image_url": url, **({"detail": detail} if detail else {})}


def image_bytes(item):
    if item["type"] == "image":
        return base64.b64decode(item["source"]["data"])
    url = item["image_url"]
    return base64.b64decode((url["url"] if isinstance(url, dict) else url).split(",", 1)[1])


def payload(content, protocol="anthropic", model="claude-opus-5-5"):
    return {"model": model, "input" if protocol == "responses" else "messages": [{"role": "user", "content": content}]}


@pytest.mark.parametrize("host,limit", [
    ("https://api.anthropic.com/v1", 10_000_000),
    ("https://bedrock-runtime.us-east-1.amazonaws.com", 5_000_000),
    ("https://us-east5-aiplatform.googleapis.com", 5_000_000),
    ("http://127.0.0.1:8080/v1", 5_000_000),
    ("https://api.anthropic.com.example.com", 5_000_000),
])
def test_claude_channel_and_whole_request_limits(host, limit):
    # An image keeps identical bytes however many images the request holds.
    assert image_limits("claude-opus-5-5", host, 1) == ImageLimits(limit, 2000)
    assert image_limits("claude-opus-5-5", host, 20) == image_limits("claude-opus-5-5", host, 21) == ImageLimits(limit, 2000)


@pytest.mark.parametrize("model,detail,patches", [
    ("gpt-6-astra", "auto", 30_000), ("gpt-6-astra", "original", 30_000),
    ("gpt-6-astra", "high", 0), ("gpt-6-astra", "low", 0),
    ("gpt-5.6-sol-2026-08-01", "original", 30_000),
    ("gpt-5.5", "auto", 0), ("gpt-5.4", "auto", 0),
    ("gpt-4.1", "auto", 0), ("gpt-4o", "auto", 0),
])
def test_openai_limits_follow_model_and_detail(model, detail, patches):
    assert image_limits(model, "http://relay/v1", 21, detail).max_patches == patches


@pytest.mark.parametrize("model", ["GLM-5.3", "MiniMax-M3", "custom-vision", "gpt-custom", "gpt-image-2"])
def test_unknown_and_compatible_models_are_not_given_another_providers_limits(model):
    original = payload([block(b"opaque image")], model=model)
    assert prepare_image_payload(original, base_url="https://example.com", protocol="anthropic") is original


@pytest.mark.parametrize("fmt,mime", [("PNG", "image/png"), ("JPEG", "image/jpeg"), ("GIF", "image/gif"), ("WEBP", "image/webp")])
def test_compliant_images_remain_byte_identical(fmt, mime):
    data = picture(fmt=fmt)
    assert prepare_image(data, mime, ImageLimits(5_000_000, 8000)) == (data, mime, "")


def test_base64_boundary_is_exact_and_metadata_only_recompression_preserves_pixels():
    data = picture()
    wire = 4 * ((len(data) + 2) // 3)
    assert prepare_image(data, "image/png", ImageLimits(max_base64_bytes=wire))[0] == data
    padded = data + b"\0" * 5000
    out, mime, note = prepare_image(padded, "image/png", ImageLimits(max_base64_bytes=wire))
    assert 4 * ((len(out) + 2) // 3) <= wire
    assert Image.open(io.BytesIO(out)).tobytes() == Image.open(io.BytesIO(data)).tobytes()
    assert mime == "image/png" and "原文件未修改" in note


def test_noisy_image_meets_encoded_byte_limit_without_modifying_input():
    data = io.BytesIO()
    Image.frombytes("RGB", (1400, 1000), random.Random(7).randbytes(4_200_000)).save(data, format="PNG")
    original = data.getvalue()
    assert len(base64.b64encode(original)) > 5_000_000
    out, mime, note = prepare_image(original, "image/png", ImageLimits(5_000_000, 8000))
    assert len(base64.b64encode(out)) <= 5_000_000
    assert mime == "image/jpeg" and note
    assert data.getvalue() == original
    assert Image.open(io.BytesIO(out)).size == (1400, 1000)


@pytest.mark.parametrize("size", [(9000, 1000), (1000, 9000), (8001, 1)])
def test_claude_pixel_limits_preserve_aspect_ratio(size):
    out, mime, note = prepare_image(picture(size), "image/png", ImageLimits(5_000_000, 8000))
    image = Image.open(io.BytesIO(out))
    assert max(image.size) <= 8000 and note
    assert abs(image.width / size[0] - image.height / size[1]) <= 1 / min(size)


@pytest.mark.parametrize("protocol", ["anthropic", "chat", "responses"])
def test_full_request_counts_history_and_nested_tool_images_without_mutation(protocol):
    large = block(picture((2500, 300)), protocol)
    tiny = block(picture(), protocol)
    original = payload([large], protocol)
    key = "input" if protocol == "responses" else "messages"
    if protocol == "responses":
        original[key].append({"type": "function_call_output", "call_id": "a", "output": [tiny] * 20})
    else:
        original[key].append({"role": "user", "content": [{"type": "tool_result", "tool_use_id": "a", "content": [tiny] * 20}]})
    snapshot = copy.deepcopy(original)
    out = prepare_image_payload(original, base_url="http://relay/v1", protocol=protocol)
    assert original == snapshot
    content = out[key][0]["content"]
    assert "2500×300" in content[0]["text"]
    assert Image.open(io.BytesIO(image_bytes(content[1]))).size == (2000, 240)
    assert len(out[key]) == len(original[key])
    assert prepare_image_payload(original, base_url="http://relay/v1", protocol=protocol) == out


def test_image_bytes_do_not_depend_on_image_count_and_tool_arguments_are_not_images():
    large = block(picture((2500, 300)))

    def build(count):
        original = payload([large] + [block(picture())] * (count - 1))
        original["messages"].append({"role": "assistant", "content": [
            {"type": "tool_use", "id": "call", "name": "example", "input": {"content": [large] * 25}},
            {"type": "thinking", "thinking": "signed", "signature": "opaque"},
        ]})
        return original

    twenty, twenty_one = (prepare_image_payload(build(n), base_url="http://relay/v1", protocol="anthropic") for n in (20, 21))
    # Crossing 20 images must not re-encode earlier images (a cached prefix rewrite).
    assert twenty["messages"][0]["content"][:2] == twenty_one["messages"][0]["content"][:2]
    assert Image.open(io.BytesIO(image_bytes(twenty["messages"][0]["content"][1]))).width == 2000
    assert twenty["messages"][-1] == build(20)["messages"][-1]


@pytest.mark.parametrize("protocol", ["chat", "responses"])
def test_openai_patch_overflow_is_scaled_but_high_detail_is_untouched(protocol):
    data = picture((5800, 5800))
    original = payload([block(data, protocol)], protocol, "gpt-6-astra")
    key = "input" if protocol == "responses" else "messages"
    out = prepare_image_payload(original, base_url="http://relay/v1", protocol=protocol)
    content = out[key][0]["content"]
    image = Image.open(io.BytesIO(image_bytes(content[1])))
    assert _patches(image.size) <= 30_000
    assert image.width == image.height
    high = payload([block(data, protocol, detail="high")], protocol, "gpt-6-astra")
    assert prepare_image_payload(high, base_url="http://relay/v1", protocol=protocol) == high


def test_patch_guard_uses_upstream_dimension_scaling_first():
    data = picture((100_000, 1))
    assert prepare_image(data, "image/png", ImageLimits(max_patches=30_000))[0] == data


def test_upstream_rounding_cannot_hide_a_patch_overflow():
    assert _patches(_fit((100_000, 685), 65_535)) < 30_000
    assert _patches(_fit((100_000, 685), 65_535, round_up=True)) > 30_000


def test_total_payload_limit_is_nonretryable_and_does_not_mutate_history(monkeypatch):
    from app.llm import image_limits as module

    original = payload([block(picture(), "responses")], "responses", "gpt-6-astra")
    snapshot = copy.deepcopy(original)
    size = len(json.dumps(original, ensure_ascii=False).encode())
    monkeypatch.setattr(module, "_OPENAI_MAX_PAYLOAD_BYTES", size)
    assert prepare_image_payload(original, base_url="http://relay/v1", protocol="responses") == original
    monkeypatch.setattr(module, "_OPENAI_MAX_PAYLOAD_BYTES", size - 1)
    with pytest.raises(OpenBearLLMError, match="512 MB") as error:
        prepare_image_payload(original, base_url="http://relay/v1", protocol="responses")
    assert not error.value.retryable and original == snapshot


def test_transparent_resize_keeps_alpha_and_exif_orientation():
    data = picture((9000, 10), mode="RGBA")
    out, mime, _ = prepare_image(data, "image/png", ImageLimits(5_000_000, 8000))
    assert Image.open(io.BytesIO(out)).mode == "RGBA"
    image = Image.new("RGB", (9000, 30), "blue")
    exif = Image.Exif()
    exif[274] = 6
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", exif=exif)
    out, mime, _ = prepare_image(buffer.getvalue(), "image/jpeg", ImageLimits(5_000_000, 8000))
    result = Image.open(io.BytesIO(out))
    assert result.size == (26, 8000)
    assert result.getexif().get(274) is None


def test_animated_openai_image_uses_first_frame():
    buffer = io.BytesIO()
    Image.new("RGB", (20, 10), "red").save(buffer, format="GIF", save_all=True, append_images=[Image.new("RGB", (20, 10), "blue")])
    out, _, note = prepare_image(buffer.getvalue(), "image/gif", ImageLimits(first_frame=True))
    result = Image.open(io.BytesIO(out))
    assert getattr(result, "n_frames", 1) == 1
    assert result.convert("RGB").getpixel((0, 0)) == (255, 0, 0) and note


@pytest.mark.parametrize("protocol", ["anthropic", "chat", "responses"])
def test_invalid_image_is_explicit_recoverable_text_not_poisonous_history(protocol):
    original = payload([block(b"invalid", protocol)], protocol)
    out = prepare_image_payload(original, base_url="http://relay/v1", protocol=protocol)
    key = "input" if protocol == "responses" else "messages"
    assert "图片未发送" in out[key][0]["content"][0]["text"]
    assert image_bytes(original[key][0]["content"][0]) == b"invalid"


def test_openai_image_count_limit_is_nonretryable():
    original = payload([block(picture(), "responses")] * 1501, "responses", "gpt-6-astra")
    with pytest.raises(OpenBearLLMError, match="1500") as error:
        prepare_image_payload(original, base_url="http://relay/v1", protocol="responses")
    assert not error.value.retryable


@pytest.mark.parametrize("cls,model", [(AnthropicBackend, "claude-opus-5-5"), (OpenAIChatBackend, "claude-opus-5-5"), (OpenAIResponsesBackend, "claude-opus-5-5")])
def test_backend_prepares_local_file_on_every_build_and_preserves_history(tmp_path, cls, model):
    path = tmp_path / "image.png"
    path.write_bytes(picture((9000, 300)))
    before = path.read_bytes()
    neutral = [{"role": "user", "content": [{"type": "text", "text": "look"}, {"type": "image", "path": str(path), "mime_type": "image/png"}]}]
    snapshot = copy.deepcopy(neutral)
    backend = cls(None, "http://relay/v1", "not-a-secret")
    first = backend.build_payload(neutral, model=model)
    assert backend.build_payload(neutral, model=model) == first
    assert neutral == snapshot and path.read_bytes() == before
    key = "input" if cls is OpenAIResponsesBackend else "messages"
    content = first[key][0]["content"]
    assert "图片发送副本" in content[1]["text"]
    assert Image.open(io.BytesIO(image_bytes(content[2]))).width == 2000
    assert list(tmp_path.iterdir()) == [path]
    if cls is AnthropicBackend:
        assert content[-1]["cache_control"] == {"type": "ephemeral"}
