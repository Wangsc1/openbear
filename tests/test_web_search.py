"""HTTP and real SQLite contract for scoped, paged transcript search and seek."""
import json

import pytest

from tests.test_web_admin import _login_cookie, web_env  # noqa: F401


@pytest.mark.asyncio
async def test_conversation_search_paged_hidden_literal_scope_and_window(web_env):
    cookie = {"openbear_web_session": await _login_cookie(web_env)}
    row = await web_env.server._create_web_conversation(123, title="search fixture")
    other = await web_env.server._create_web_conversation(123, title="other fixture")
    foreign = await web_env.server._create_web_conversation(456, title="foreign owner")
    conv, other_conv = row["conversation_uuid"], other["conversation_uuid"]

    async def insert(uuid, op_id, op_type, seq, text, *, turn=None, internal=0, payload_extra=None):
        await web_env.db.conn.execute(
            """INSERT INTO web_operations
               (conversation_uuid,internal_chat_id,op_id,op_type,turn_uuid,run_root_turn_uuid,
                display_seq,status,lifecycle,internal,revision,payload_json,created_at_ms,updated_at_ms)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (uuid, row["internal_chat_id"], op_id, op_type, turn or f"turn-{seq}", turn or f"turn-{seq}",
             seq, "completed", "terminal", internal, 1, json.dumps({"text": text, **(payload_extra or {})}),
             1700000000000 + seq, 1700000000000 + seq),
        )

    literal = "needle_%\\"
    for number in range(125):
        turn = f"turn-{number}"
        await insert(conv, f"user-{number}", "user_message", number * 20 + 10,
                     f"用户正文 {literal if number < 30 else '其它文字'} {number}", turn=turn)
        await insert(conv, f"assistant-{number}", "assistant_message", number * 20 + 20,
                     f"模型回复 {literal if number < 3 else '其它文字'} {number}", turn=turn)
    await insert(conv, "tool-decoy", "tool", 2600, "scope-only-xyz")
    await insert(conv, "reason-decoy", "reasoning", 2610, "scope-only-xyz")
    await insert(conv, "private-decoy", "assistant_message", 2620, "scope-only-xyz", internal=1)
    await insert(conv, "attachment-decoy", "user_message", 2630, "普通正文", payload_extra={"attachments": [{"content": "scope-only-xyz"}]})
    await insert(other_conv, "other-decoy", "user_message", 10, "scope-only-xyz")
    await insert(conv, "hidden-user", "user_message", 2640, f"隐藏 {literal}")
    await web_env.db.conn.execute(
        "INSERT INTO web_hidden_operations(conversation_uuid,op_id,hidden_at_ms) VALUES(?,?,?)", (conv, "hidden-user", 1),
    )
    await web_env.db.conn.commit()
    base = f"/api/conversations/{conv}"

    state_resp = await web_env.client.get(f"{base}/state", params={"timelineLimit": 200}, cookies=cookie)
    assert state_resp.status == 200
    initial = await state_resp.json()
    assert "user-0" not in {op["opId"] for op in initial["operations"]}
    assert initial["hasMoreBefore"]

    async def search(q, **params):
        response = await web_env.client.get(f"{base}/search", params={"q": q, **params}, cookies=cookie)
        assert response.status == 200, await response.text()
        return await response.json()

    first = await search(literal)
    assert len(first["items"]) == 20
    assert first["nextCursor"]
    assert first["items"][0]["opId"] == "user-29"
    assert all(item["snippet"] and literal in item["snippet"] for item in first["items"])
    await insert(conv, "new-user", "user_message", 2650, literal)
    full_body = "x" * 5000 + "long-search-only" + "y" * 5000
    await insert(conv, "user-long", "user_message", 2660, full_body)
    await web_env.db.conn.commit()
    second = await search(literal, cursor=first["nextCursor"])
    assert len(second["items"]) == 13  # 30 users + three assistant replies; later new row is excluded
    assert second["nextCursor"] is None
    assert "user-0" in {item["opId"] for item in second["items"]}
    assert "new-user" not in {item["opId"] for item in second["items"]}
    assert len({item["opId"] for item in [*first["items"], *second["items"]]}) == 33
    assert (await search(literal))["items"][0]["opId"] == "new-user"
    long_hit = (await search("long-search-only"))["items"][0]
    assert long_hit["opId"] == "user-long" and "long-search-only" in long_hit["snippet"]
    assert len(long_hit["snippet"]) < 220 and full_body not in long_hit["snippet"]

    hidden = await search(literal, includeHidden="true")
    target = next(item for item in hidden["items"] if item["opId"] == "hidden-user")
    assert target["hidden"] and target["snippet"] is None
    preview = await web_env.client.get(f"{base}/hidden-messages/hidden-user", cookies=cookie)
    assert preview.status == 200
    assert literal in (await preview.json())["operation"]["payload"]["text"]
    assert (await search(literal))["items"][0]["opId"] == "new-user"  # preview never unhides
    bad_cursor = await web_env.client.get(f"{base}/search", params={"q": "different", "cursor": first["nextCursor"]}, cookies=cookie)
    assert bad_cursor.status == 400
    assert not (await search("scope-only-xyz"))["items"]  # excludes tool, reasoning, internal, attachment body, other chat
    assert (await search("普通正文"))["items"][0]["opId"] == "attachment-decoy"
    assert not (await search("needleZZ"))["items"]  # %, _, backslash are literal, not wildcards

    window = await web_env.client.get(f"{base}/operations/user-0/window", cookies=cookie)
    assert window.status == 200
    window_ops = (await window.json())["operations"]
    assert {"user-0", "assistant-0"}.issubset({op["opId"] for op in window_ops})
    assert len(window_ops) < 60 and "user-124" not in {op["opId"] for op in window_ops}
    assert all(op["conversationUuid"] == conv for op in window_ops)
    assert (await web_env.client.get(f"{base}/operations/other-decoy/window", cookies=cookie)).status == 404
    assert (await web_env.client.get(f"/api/conversations/{other_conv}/search", params={"q": literal}, cookies=cookie)).status == 200
    assert (await web_env.client.get(f"/api/conversations/{foreign['conversation_uuid']}/search", params={"q": literal}, cookies=cookie)).status == 404
    web_env.client.session.cookie_jar.clear()
    assert (await web_env.client.get(f"{base}/search", params={"q": literal})).status == 401
    assert (await web_env.client.get(f"{base}/operations/user-0/window")).status == 401
