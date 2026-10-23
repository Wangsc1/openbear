#!/usr/bin/env python3
"""把 Web 参考截图与 App 截图按用例并排拼接（同一设备像素比 2.625），输出到报告截图目录。"""
import glob, os, sys
from PIL import Image, ImageDraw
web_dir, app_dir, out_dir, theme = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
os.makedirs(out_dir, exist_ok=True)
for web in sorted(glob.glob(f"{web_dir}/web-{theme}-*.png")):
    cid = os.path.basename(web)[len(f"web-{theme}-"):-4]
    app = f"{app_dir}/app-{theme}-{cid}.png"
    if not os.path.exists(app):
        continue
    w = Image.open(web).convert("RGB")
    a = Image.open(app).convert("RGB")
    # App 截图去掉状态栏+工具条(约 330px)和底部手势条
    a = a.crop((0, 300, a.width, a.height - 140))
    h = max(w.height, a.height)
    canvas = Image.new("RGB", (w.width + a.width + 30, h + 50), "white")
    canvas.paste(w, (0, 50)); canvas.paste(a, (w.width + 30, 50))
    d = ImageDraw.Draw(canvas)
    d.text((10, 10), f"WEB (markdown-it, Chrome) : {cid}", fill="black")
    d.text((w.width + 40, 10), "APP (react-native-enriched-markdown, Android)", fill="black")
    canvas = canvas.resize((canvas.width // 2, canvas.height // 2))
    path = f"{out_dir}/md-{theme}-{cid}.png"
    canvas.save(path)
    print(path, canvas.size)
