"""Prepare request-only image copies; never rewrite source files or history."""
from __future__ import annotations

import base64
import io
import json
import math
import re
import warnings
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

from PIL import Image, ImageOps

from app.llm.base import OpenBearLLMError


@dataclass(frozen=True)
class ImageLimits:
    max_base64_bytes: int = 0
    max_dimension: int = 0
    max_patches: int = 0
    first_frame: bool = False


_OPENAI_MAX_IMAGES = 1500
_OPENAI_MAX_PAYLOAD_BYTES = 512_000_000
_OPENAI_VISION = re.compile(
    r"^(?:gpt-(?:6-astra|5\.6-(?:sol|terra|luna)|5\.5|5\.4(?:-mini|-nano)?|"
    r"5\.2|5\.1|5(?:-mini|-nano)?|4\.1(?:-mini|-nano)?|4o(?:-mini)?)|o[134](?:-mini|-pro)?)"
    r"(?:-\d{4}-\d{2}-\d{2})?$"
)
_UNCAPPED_PATCH_MODELS = re.compile(
    r"^gpt-(?:6-astra|5\.6-(?:sol|terra|luna))(?:-\d{4}-\d{2}-\d{2})?$"
)


def image_limits(model: str, base_url: str, image_count: int, detail: str = "auto") -> ImageLimits:
    model = model.lower()
    if model.startswith("claude-"):
        # A relay's protocol does not reveal whether it uses the direct or cloud API.
        direct = urlparse(base_url).hostname == "api.anthropic.com"
        # The API allows 8000px only while a request holds at most 20 images.
        # Sizing by that count re-encodes every earlier image once the context
        # grows past 20, rewriting the whole cached prefix; use the stable bound.
        return ImageLimits(max_base64_bytes=(10 if direct else 5) * 1_000_000, max_dimension=2000)
    if _OPENAI_VISION.fullmatch(model):
        patches = 30_000 if _UNCAPPED_PATCH_MODELS.fullmatch(model) and detail in {"auto", "original"} else 0
        return ImageLimits(max_patches=patches, first_frame=True)
    return ImageLimits()


def _patches(size: tuple[int, int]) -> int:
    return math.ceil(size[0] / 32) * math.ceil(size[1] / 32)


def _fit(size: tuple[int, int], maximum: int, *, round_up: bool = False) -> tuple[int, int]:
    scale = min(1.0, maximum / max(size))
    rounding = math.ceil if round_up else int
    return max(1, rounding(size[0] * scale)), max(1, rounding(size[1] * scale))


def _patch_size(size: tuple[int, int], budget: int) -> tuple[int, int]:
    lo, hi = 0.0, 1.0
    for _ in range(48):
        scale = (lo + hi) / 2
        candidate = max(1, int(size[0] * scale)), max(1, int(size[1] * scale))
        if _patches(candidate) <= budget:
            lo = scale
        else:
            hi = scale
    return max(1, int(size[0] * lo)), max(1, int(size[1] * lo))


def prepare_image(data: bytes, mime: str, limits: ImageLimits) -> tuple[bytes, str, str]:
    if limits == ImageLimits():
        return data, mime, ""
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(io.BytesIO(data)) as original:
            size = original.size
            target = _fit(size, limits.max_dimension) if limits.max_dimension else size
            if limits.max_patches:
                processed = _fit(size, 65_535, round_up=True)
                if _patches(processed) > limits.max_patches:
                    target = _patch_size(processed, limits.max_patches)
            too_large = limits.max_base64_bytes and 4 * ((len(data) + 2) // 3) > limits.max_base64_bytes
            animated = limits.first_frame and getattr(original, "is_animated", False)
            if target == size and not too_large and not animated:
                return data, mime, ""
            original.seek(0)
            image = ImageOps.exif_transpose(original)
            if image.size != size:
                target = target[::-1]
            if image.size != target:
                image = image.resize(target, Image.Resampling.LANCZOS)
            if image.mode not in {"RGB", "RGBA", "L", "LA"}:
                image = image.convert("RGBA" if "transparency" in image.info else "RGB")
            raw_limit = (limits.max_base64_bytes // 4) * 3 if limits.max_base64_bytes else 0
            for _ in range(16):
                buffer = io.BytesIO()
                image.save(buffer, format="PNG")
                encoded = buffer.getvalue()
                out_mime = "image/png"
                if not raw_limit or len(encoded) <= raw_limit:
                    break
                rgb = Image.new("RGB", image.size, "white")
                if image.mode in {"RGBA", "LA"}:
                    rgb.paste(image.convert("RGB"), mask=image.getchannel("A"))
                else:
                    rgb.paste(image.convert("RGB"))
                for quality in (95, 85, 75):
                    buffer = io.BytesIO()
                    rgb.save(buffer, format="JPEG", quality=quality, subsampling=0)
                    encoded = buffer.getvalue()
                    out_mime = "image/jpeg"
                    if len(encoded) <= raw_limit:
                        break
                if len(encoded) <= raw_limit:
                    break
                factor = min(0.85, math.sqrt(raw_limit / len(encoded)) * 0.95)
                smaller = max(1, int(image.width * factor)), max(1, int(image.height * factor))
                if smaller == image.size:
                    raise ValueError("图片无法缩到发送字节上限")
                image = image.resize(smaller, Image.Resampling.LANCZOS)
            else:
                raise ValueError("图片无法缩到发送字节上限")
            note = (f"[图片发送副本：原尺寸 {size[0]}×{size[1]}，本次尺寸 {image.width}×{image.height}；"
                    "原文件未修改。精细文字或坐标任务可读取原图局部裁切。]")
            return encoded, out_mime, note


def _content_lists(payload: dict[str, Any]):
    def visit(content):
        if not isinstance(content, list):
            return
        yield content
        for block in content:
            if isinstance(block, dict) and block.get("type") == "tool_result":
                yield from visit(block.get("content"))

    for message in payload.get("messages", payload.get("input", [])):
        if isinstance(message, dict):
            yield from visit(message.get("content"))
            if message.get("type") == "function_call_output":
                yield from visit(message.get("output"))


def _inline_image(block: dict[str, Any]) -> tuple[str, str] | None:
    if block.get("type") == "image":
        source = block.get("source")
        if isinstance(source, dict) and source.get("type") == "base64":
            return str(source.get("data") or ""), str(source.get("media_type") or "")
    elif block.get("type") in {"image_url", "input_image"}:
        url = block.get("image_url")
        if isinstance(url, dict):
            url = url.get("url")
        if isinstance(url, str) and url.startswith("data:"):
            header, sep, data = url.partition(",")
            if sep and header.endswith(";base64"):
                return data, header[5:-7]
    return None


def prepare_image_payload(payload: dict[str, Any], *, base_url: str, protocol: str) -> dict[str, Any]:
    model = str(payload.get("model") or "").lower()
    if not model.startswith("claude-") and not _OPENAI_VISION.fullmatch(model):
        return payload
    lists = list(_content_lists(payload))
    count = sum(1 for content in lists for block in content if isinstance(block, dict)
                and block.get("type") in {"image", "input_image", "image_url"})
    if not count:
        return payload
    if _OPENAI_VISION.fullmatch(model) and count > _OPENAI_MAX_IMAGES:
        raise OpenBearLLMError("图片请求超过 1500 张，请减少本次上下文中的图片后重试。",
                               status=400, retryable=False, protocol=protocol)

    # Clone content containers, not tool arguments or signed native output blocks.
    def convert(content):
        if not isinstance(content, list):
            return content
        result = []
        for block in content:
            if not isinstance(block, dict):
                result.append(block)
                continue
            if block.get("type") == "tool_result":
                result.append({**block, "content": convert(block.get("content"))})
                continue
            inline = _inline_image(block)
            if inline is None:
                result.append(block)
                continue
            detail = block.get("detail", "auto")
            if isinstance(block.get("image_url"), dict):
                detail = block["image_url"].get("detail", "auto")
            limits = image_limits(model, base_url, count, detail)
            try:
                data = base64.b64decode(inline[0], validate=True)
                prepared, mime, note = prepare_image(data, inline[1], limits)
            except (OSError, ValueError, SyntaxError, Image.DecompressionBombError,
                    Image.DecompressionBombWarning) as exc:
                text_type = "input_text" if protocol == "responses" else "text"
                result.append({"type": text_type, "text": (
                    f"[图片未发送：无法安全处理（{type(exc).__name__}）。请重新读取有效图片或较小的裁切副本。]"
                )})
                continue
            if not note:
                result.append(block)
                continue
            encoded = base64.b64encode(prepared).decode("ascii")
            updated = dict(block)
            if block["type"] == "image":
                updated["source"] = {**block["source"], "media_type": mime, "data": encoded}
            elif isinstance(block.get("image_url"), dict):
                updated["image_url"] = {**block["image_url"], "url": f"data:{mime};base64,{encoded}"}
            else:
                updated["image_url"] = f"data:{mime};base64,{encoded}"
            result.extend([{"type": "input_text" if protocol == "responses" else "text", "text": note}, updated])
        return result

    key = "messages" if "messages" in payload else "input"
    messages = []
    for message in payload[key]:
        updated = dict(message)
        if "content" in message:
            updated["content"] = convert(message["content"])
        if message.get("type") == "function_call_output":
            updated["output"] = convert(message.get("output"))
        messages.append(updated)
    prepared_payload = {**payload, key: messages}
    if _OPENAI_VISION.fullmatch(model) and len(json.dumps(prepared_payload, ensure_ascii=False).encode()) > _OPENAI_MAX_PAYLOAD_BYTES:
        raise OpenBearLLMError("图片请求总负载超过 512 MB，请减少本次上下文中的图片后重试。",
                               status=400, retryable=False, protocol=protocol)
    return prepared_payload
