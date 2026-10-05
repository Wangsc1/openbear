"""用户消息尾部模板：显式构造变量、纯渲染和不修改原消息的拼接。

不读取配置、记忆、工具或凭据，也不写渲染日志。调用方应为每条消息只构造一次
变量/后缀并在重试时复用；渲染与拼接不会读取时钟。
"""
from __future__ import annotations

import ast
import copy
import platform
import re
from collections.abc import Mapping, Sequence
from datetime import datetime
from functools import lru_cache
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

from app.memory.builtin import TemplateEngine

if TYPE_CHECKING:
    from app.config import UserMessageTemplateConfig

DEFAULT_USER_MESSAGE_TEMPLATE = "[⏰ 当前时间: [[ time.now ]] ([[ time.weekday ]])]"
_VARIABLE_FIELDS = {
    "time": ("now", "iso", "date", "clock", "weekday", "timezone", "utcOffset", "timestamp"),
    "message": ("id", "source", "sentAt", "attachmentCount", "attachments"),
    "conversation": ("id", "title", "folderPath"),
    "runtimeInfo": ("model", "host", "os"),
}
USER_MESSAGE_TEMPLATE_VARIABLES = tuple(
    f"{root}.{field}" for root, fields in _VARIABLE_FIELDS.items() for field in fields
) + ("folderWorkspaceDir",)
_TZ = ZoneInfo("Asia/Shanghai")
_WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
_BUILTINS = frozenset({"len", "str", "int", "float", "bool", "list"})
_HELPERS = frozenset({
    "noteSuffix", "has", "join", "ownerLine", "runtimeLine", "toolLines", "mcpGroupLines", "literalBlock",
})
_ENGINE = TemplateEngine()


def _local_time(value: datetime) -> datetime:
    if not isinstance(value, datetime):
        raise TypeError("at/sent_at 必须是 datetime 或 None")
    # 与项目当前时间约定一致；无时区 datetime 视为北京时间。
    return value.replace(tzinfo=_TZ) if value.tzinfo is None else value.astimezone(_TZ)


def build_message_variables(
    *,
    at: datetime | None = None,
    source: str = "web",
    message_id: str = "",
    sent_at: datetime | None = None,
    conversation: Mapping[str, Any] | None = None,
    model: str = "",
    workspace: str = "",
    attachments: Sequence[Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """构造一次消息变量快照。

    at/sent_at 接受 datetime（有时区会转北京时间，无时区视为北京时间）。
    at 缺省只读取一次当前时间；sent_at 缺省复用 at。时间文本使用 ISO/24 小时制，
    weekday 为英文全名，与原 now_cn 一致，timestamp 为 Unix 秒（float）。
    conversation 只取 id/title/folderPath；attachments 为调用方提供的附件元数据，
    深拷贝后原样保留，不读取附件正文或外部文件。
    """
    instant = _local_time(at) if at is not None else datetime.now(_TZ)
    sent = _local_time(sent_at) if sent_at is not None else instant
    offset = instant.strftime("%z")
    conversation = conversation or {}
    attachment_items = copy.deepcopy(list(attachments or []))
    return {
        "time": {
            "now": instant.strftime("%Y-%m-%d %H:%M:%S"),
            "iso": instant.isoformat(),
            "date": instant.strftime("%Y-%m-%d"),
            "clock": instant.strftime("%H:%M:%S"),
            "weekday": _WEEKDAYS[instant.weekday()],
            "timezone": _TZ.key,
            "utcOffset": f"{offset[:3]}:{offset[3:]}",
            "timestamp": instant.timestamp(),
        },
        "message": {
            "id": str(message_id),
            "source": source,
            "sentAt": sent.isoformat(),
            "attachmentCount": len(attachment_items),
            "attachments": attachment_items,
        },
        "conversation": {key: str(conversation.get(key) or "") for key in _VARIABLE_FIELDS["conversation"]},
        "runtimeInfo": {"model": model, "host": platform.node(), "os": platform.system()},
        "folderWorkspaceDir": workspace,
    }


def _path(node: ast.AST) -> tuple[str, ...]:
    if isinstance(node, ast.Name):
        return (node.id,)
    if isinstance(node, ast.Attribute):
        return (*_path(node.value), node.attr)
    if isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Constant) and isinstance(node.slice.value, str):
        return (*_path(node.value), node.slice.value)
    return ()


def _validate_expression(expression: str, local_names: set[str]) -> None:
    try:
        tree = ast.parse(_ENGINE._translate_expr(expression), mode="eval")
    except SyntaxError as exc:
        raise ValueError(f"模板表达式语法错误：{expression}") from exc
    allowed_names = set(_VARIABLE_FIELDS) | {"folderWorkspaceDir", "helpers"} | _BUILTINS | local_names
    for node in ast.walk(tree):
        if isinstance(node, (ast.Lambda, ast.NamedExpr, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
            raise ValueError("模板不支持赋值、lambda 或推导式")
        if isinstance(node, ast.Name) and node.id not in allowed_names:
            raise ValueError(f"不支持的模板变量：{node.id}")
        if isinstance(node, ast.Attribute) and node.attr.startswith("_"):
            raise ValueError("模板不支持私有属性")
        path = _path(node)
        if len(path) >= 2 and path[0] in _VARIABLE_FIELDS:
            if path[1] not in _VARIABLE_FIELDS[path[0]]:
                raise ValueError(f"不支持的模板变量：{'.'.join(path[:2])}")
            if len(path) > 2 and path != ("message", "attachments", "length"):
                raise ValueError(f"不支持的模板变量：{'.'.join(path)}")
        if len(path) >= 2 and path[0] == "helpers" and (len(path) != 2 or path[1] not in _HELPERS):
            raise ValueError(f"不支持的模板辅助函数：{'.'.join(path)}")
        if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name) and node.value.id in _VARIABLE_FIELDS:
            if not isinstance(node.slice, ast.Constant) or not isinstance(node.slice.value, str):
                raise ValueError("模板变量字段必须使用固定名称")
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id in _BUILTINS:
                continue
            if isinstance(node.func, ast.Attribute):
                if _path(node.func)[:1] == ("helpers",) and node.func.attr in _HELPERS:
                    continue
                if node.func.attr == "join" and isinstance(node.func.value, ast.Constant) and isinstance(node.func.value.value, str):
                    continue
            raise ValueError("模板只支持内置转换函数、helpers 和字符串 join 调用")


@lru_cache(maxsize=128)
def validate_user_message_template(template: str) -> None:
    """检查所有分支（含未执行分支）的语法和变量；空模板合法。

    渲染沿用现有 TemplateEngine；这里补足其宽容解析会忽略的错误。
    @raw 内不解析变量。支持循环局部变量及附件元数据字段。
    """
    stack: list[tuple[str, str]] = []
    locals_: set[str] = set()
    in_raw = False
    for line in template.splitlines():
        stripped = line.strip()
        if in_raw:
            if stripped == "@endraw":
                in_raw = False
            continue
        if stripped == "@raw":
            in_raw = True
            continue
        if stripped.startswith("@if "):
            _validate_expression(stripped[4:].strip(), locals_)
            stack.append(("if", ""))
            continue
        if stripped.startswith("@each "):
            match = _ENGINE._each_re.fullmatch(stripped)
            if not match:
                raise ValueError("模板 @each 语法错误")
            name, expression = match.groups()
            if not name.isidentifier() or name.startswith("_") or name in locals_ | set(_VARIABLE_FIELDS) | {"helpers", "folderWorkspaceDir"} | _BUILTINS:
                raise ValueError(f"模板循环变量不可用：{name}")
            _validate_expression(expression, locals_)
            stack.append(("each", name))
            locals_.add(name)
            continue
        if stripped == "@else":
            if not stack or stack[-1][0] != "if":
                raise ValueError("模板 @else 没有匹配的 @if 或重复出现")
            stack[-1] = ("else", "")
            continue
        if stripped in {"@endif", "@endeach"}:
            expected = {"if", "else"} if stripped == "@endif" else {"each"}
            if not stack or stack[-1][0] not in expected:
                raise ValueError(f"模板 {stripped} 没有匹配的开始指令")
            _, name = stack.pop()
            locals_.discard(name)
            continue
        if re.match(r"^@(if|else|endif|each|endeach|raw|endraw)\b", stripped):
            raise ValueError(f"模板指令语法错误：{stripped}")
        matches = list(_ENGINE._expr_re.finditer(line))
        for match in matches:
            _validate_expression(match.group(1), locals_)
        remainder = _ENGINE._expr_re.sub("", line)
        if "[[" in remainder or "]]" in remainder:
            raise ValueError("模板 [[ ]] 未配对；字面内容请放在 @raw 块中")
    if stack or in_raw:
        raise ValueError("模板存在未闭合的 @if、@each 或 @raw")


class _SuffixEngine(TemplateEngine):
    def _interpolate(self, line: str, ctx: dict[str, Any]) -> str:
        # 普通引擎在表达式失败时内联 ERROR；设置预览应明确报错，不保存错误后缀。
        def replace(match: re.Match[str]) -> str:
            value = self._eval(match.group(1), ctx)
            return str(value if value is not None else "")
        return self._expr_re.sub(replace, line)


def render_user_message_suffix(
    settings: UserMessageTemplateConfig | Mapping[str, Any] | None,
    variables: Mapping[str, Any],
) -> str:
    """纯渲染；None 使用缺省设置，禁用/空白模板返回空字符串。

    settings 可直接传 Config.user_message_template 或 {enabled, template}。
    不生成时间，不访问配置或数据库；variables 来自消息的固定快照。
    """
    if isinstance(settings, Mapping):
        enabled = settings.get("enabled", True)
        template = settings.get("template", DEFAULT_USER_MESSAGE_TEMPLATE)
    else:
        enabled = getattr(settings, "enabled", True)
        template = getattr(settings, "template", DEFAULT_USER_MESSAGE_TEMPLATE)
    if not enabled or not template.strip():
        return ""
    validate_user_message_template(template)
    # 只提供契约变量，不能通过额外根变量注入工具、凭据或替换 helpers。
    context = {key: copy.deepcopy(variables[key]) for key in (*_VARIABLE_FIELDS, "folderWorkspaceDir") if key in variables}
    try:
        return _SuffixEngine().render(template, context).strip()
    except Exception as exc:
        raise ValueError(f"用户消息模板渲染失败：{exc}") from exc


def append_user_message_suffix(content: str | list[Any], suffix: str) -> str | list[Any]:
    """以空行分隔追加后缀；多模态列表深拷贝，保留图片/音频等块及其顺序。"""
    if isinstance(content, str):
        return f"{content}\n\n{suffix}" if suffix and content else content or suffix
    if not isinstance(content, list):
        raise TypeError("用户消息内容必须是 str 或 list")
    blocks = copy.deepcopy(content)
    if not suffix:
        return blocks
    if blocks and isinstance(blocks[-1], dict) and blocks[-1].get("type") == "text":
        text = blocks[-1].get("text") or ""
        blocks[-1]["text"] = f"{text}\n\n{suffix}" if text else suffix
    else:
        # 以非文本块结尾时新增末尾 text 块，保持多模态及 prompt-cache 断点语义。
        blocks.append({"type": "text", "text": suffix})
    return blocks
