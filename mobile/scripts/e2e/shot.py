#!/usr/bin/env python3
"""截图 + 像素检查 + 界面层级摘要（验收辅助）。

用法：shot.py <name> [--serial emulator-5554] [--out DIR]
输出：<out>/<name>.png（原尺寸），并打印：
  - 顶部状态栏区域、底部手势条区域、内容区的主色（判断 edge-to-edge 与深浅色）
  - 平均亮度（深色模式判定）
  - uiautomator 可见文字摘要（前 N 条）
"""
from __future__ import annotations

import argparse
import collections
import html
import os
import re
import subprocess
from pathlib import Path

from PIL import Image

ADB = os.path.join(os.environ.get("ANDROID_HOME") or os.path.expanduser("~/Android/Sdk"), "platform-tools", "adb")


def adb(serial: str, *args: str, binary: bool = False):
    out = subprocess.run([ADB, "-s", serial, *args], capture_output=True, check=False)
    return out.stdout if binary else out.stdout.decode("utf-8", "replace")


def dominant(im: Image.Image, box: tuple[int, int, int, int]) -> tuple[str, float]:
    region = im.crop(box).convert("RGB").resize((64, 16))
    counts = collections.Counter(region.get_flattened_data() if hasattr(region,'get_flattened_data') else region.getdata())
    color, n = counts.most_common(1)[0]
    return "#%02x%02x%02x" % color, round(n / (64 * 16), 2)


def luminance(im: Image.Image) -> float:
    small = im.convert("L").resize((60, 120))
    data = list(small.get_flattened_data() if hasattr(small,'get_flattened_data') else small.getdata())
    return round(sum(data) / len(data), 1)


def ascii_art(im: Image.Image, cols: int) -> str:
    ramp = " .:-=+*#%@"
    w, h = im.size
    rows = int(cols * h / w * 0.5)
    small = im.convert("L").resize((cols, rows))
    px = list(small.get_flattened_data() if hasattr(small, "get_flattened_data") else small.getdata())
    lo, hi = min(px), max(px)
    span = max(1, hi - lo)
    out = []
    for y in range(rows):
        line = "".join(ramp[int((hi - px[y * cols + x]) / span * (len(ramp) - 1))] for x in range(cols))
        out.append(line.rstrip())
    return "\n".join(out)


def ui_texts(serial: str, limit: int) -> list[str]:
    adb(serial, "shell", "uiautomator", "dump", "/sdcard/ui.xml")
    xml = adb(serial, "shell", "cat", "/sdcard/ui.xml")
    rows = []
    for m in re.finditer(r'<node [^>]*?text="([^"]*)"[^>]*?resource-id="([^"]*)"[^>]*?content-desc="([^"]*)"[^>]*?bounds="([^"]*)"', xml):
        text, rid, desc, bounds = m.groups()
        label = html.unescape(text or desc)
        rid = rid.split("/")[-1] if rid else ""
        if label or rid:
            rows.append(f"{bounds} {rid} {label[:100]}".replace("\n", "⏎"))
    return rows[:limit]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("name")
    parser.add_argument("--serial", default="emulator-5554")
    parser.add_argument("--out", default=os.path.join(os.environ.get("OPENBEAR_MOBILE_DATA") or os.path.expanduser("~/.cache/openbear-mobile"), "shots"))
    parser.add_argument("--texts", type=int, default=25)
    parser.add_argument("--ascii", type=int, default=0, help="coarse ASCII render width (0=off)")
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    png = adb(args.serial, "exec-out", "screencap", "-p", binary=True)
    path = out / f"{args.name}.png"
    path.write_bytes(png)
    im = Image.open(path)
    w, h = im.size
    status = dominant(im, (0, 0, w, int(h * 0.025)))
    nav = dominant(im, (0, h - int(h * 0.02), w, h))
    content = dominant(im, (0, int(h * 0.3), w, int(h * 0.7)))
    print(f"saved {path} size={w}x{h} luminance={luminance(im)} statusBar={status} navBar={nav} content={content}")
    if args.ascii:
        print(ascii_art(im, args.ascii))
    for line in ui_texts(args.serial, args.texts):
        print("  ", line)


if __name__ == "__main__":
    main()
