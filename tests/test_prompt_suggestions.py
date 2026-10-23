from __future__ import annotations

import json

from app.prompt_suggestions import (
    interaction_answer_text,
    parse_suggestions,
    render_suggestion_request,
    stored_suggestions,
    suggestion_turns,
)


def test_parse_accepts_json_fences_and_numbered_lines():
    assert parse_suggestions('```json\n["提交一下", "顺便补个测试"]\n```', 3) == ["提交一下", "顺便补个测试"]
    assert parse_suggestions('好的：["部署上线"]', 3) == ["部署上线"]
    assert parse_suggestions("1. 提交一下\n2）部署上线\n- “再看下手机端”", 3) == ["提交一下", "部署上线", "再看下手机端"]


def test_parse_filters_noise_duplicates_and_limits_count():
    raw = json.dumps(["我来帮你提交", "无", "提交一下", "提交一下！", "x" * 81, "部署上线", "再跑一遍测试", "看下日志"])
    assert parse_suggestions(raw, 3) == ["提交一下", "部署上线", "再跑一遍测试"]
    assert parse_suggestions("[]", 3) == []
    assert parse_suggestions("", 3) == []


def test_parse_drops_bare_pleasantries_but_keeps_instructions():
    raw = json.dumps(["谢谢！", "辛苦了", "完美", "Thanks", "好的", "好的，提交吧", "不错，再跑一遍测试"])
    assert parse_suggestions(raw, 5) == ["好的", "好的，提交吧", "不错，再跑一遍测试"]


def test_interaction_answers_count_as_user_words():
    select = json.dumps({"action": "select", "status": "answered", "cancelled": False,
                         "selectedLabels": ["方案 A"], "text": "手机端也要能用"})
    assert interaction_answer_text(select) == "（在交互面板中回答）选择：方案 A；补充：手机端也要能用"
    confirm = json.dumps({"action": "confirm", "status": "answered", "cancelled": False, "label": "按方案修改", "text": ""})
    assert interaction_answer_text(confirm) == "（在交互面板中回答）点击：按方案修改"
    assert interaction_answer_text(json.dumps({"status": "timeout"})) == ""
    assert interaction_answer_text("not json") == ""


def test_turns_keep_user_words_and_only_the_final_reply():
    answer = json.dumps({"action": "confirm", "status": "answered", "cancelled": False, "label": "确认"})
    notice = '<task-notification>\n{"summary": "测试全部通过"}\n</task-notification>'
    rows = [
        {"id": 1, "role": "user", "content": "修一下登录", "run_root_turn_uuid": "t1"},
        {"id": 2, "role": "assistant", "content": "我先看下代码。", "run_root_turn_uuid": "t1"},
        {"id": 3, "role": "tool", "name": "UserInteraction", "content": answer, "run_root_turn_uuid": "t1"},
        {"id": 4, "role": "tool", "name": "Bash", "content": "ignored", "run_root_turn_uuid": "t1"},
        {"id": 5, "role": "assistant", "content": "修好了，要提交吗？", "run_root_turn_uuid": "t1"},
        {"id": 6, "role": "user", "content": "<openbear-task-memory-state>snapshot", "run_root_turn_uuid": "t1"},
        {"id": 7, "role": "user", "content": notice, "run_root_turn_uuid": "t2"},
        {"id": 8, "role": "assistant", "content": "后台测试都过了。", "run_root_turn_uuid": "t2"},
        {"id": 9, "role": "user", "content": "还没回复的一轮", "run_root_turn_uuid": "t3"},
    ]
    assert suggestion_turns(rows) == [
        {"user": "修一下登录\n\n（在交互面板中回答）点击：确认", "assistant": "修好了，要提交吗？"},
        {"user": "（系统：后台 Agent 任务结束通知：测试全部通过）", "assistant": "后台测试都过了。"},
    ]


def test_request_carries_transcript_and_count():
    text = render_suggestion_request([{"user": "修一下登录", "assistant": "修好了"}], 2)
    assert "第 1 轮\n用户：修一下登录\n助手：修好了" in text
    assert text.endswith("最多 2 条。")
    assert render_suggestion_request([], 3) == ""


def test_stored_suggestions_tolerates_malformed_values():
    assert stored_suggestions("{}") == {}
    assert stored_suggestions("oops") == {}
    assert stored_suggestions('{"items": ["", "提交"], "turnUuid": "t"}') == {"turnUuid": "t", "items": ["提交"], "createdAtMs": 0}
