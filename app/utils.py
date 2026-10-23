"""杂项工具 —— token 估算 + 时间。"""
from __future__ import annotations

import re
from datetime import datetime
from zoneinfo import ZoneInfo

_TZ = ZoneInfo("Asia/Shanghai")
_NON_CJK = re.compile("[^\u4e00-\u9fff]+")


def estimate_tokens(text: str) -> int:
    """粗估 token 数：中文按字符、英文按 ~4 字符/token 混合估算。"""
    if not text:
        return 0
    other = sum(map(len, _NON_CJK.findall(text)))
    cjk = len(text) - other
    return cjk + other // 4 + 1


def now_cn() -> str:
    return datetime.now(_TZ).strftime("%Y-%m-%d %H:%M:%S (%A)")
