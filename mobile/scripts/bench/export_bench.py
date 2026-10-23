#!/usr/bin/env python3
"""Export OpenBear benchmark conversations from the production DB (READ-ONLY).

The DB is opened with ``mode=ro`` (SQLite URI), so any accidental write raises.
Projection rules are not re-implemented here: the script imports the backend's own
methods (``_web_operations_page``, ``_web_operations``, ``_web_frames``,
``_project_context_compaction_operations``, ``operation_public``, ``frame_public``)
and binds them to a tiny host object whose ``db.conn`` is the read-only connection.

Output (default $OPENBEAR_MOBILE_DATA/bench, else ~/.cache/openbear-mobile/bench; never inside the git repo):
  manifest.json                         conversations, page chains, stream sample, corpus
  conv/<uuid>/operations.json           full summary snapshot (include_tool_details=False)
  conv/<uuid>/pages-<limit>.json        backend page chain: [{beforeDisplaySeq, operations, page}]
  conv/<uuid>/frames.json               all retained frames (frame_public)
  conv/<uuid>/details.jsonl             full detail snapshots for tool/reasoning/... (detail endpoint)
  conv/<uuid>/state-base.json           the non-operation fields of the /state response
  stream/<name>.json                    one real streaming turn: frames with original timestamps
  markdown-corpus.json                  real assistant texts grouped by Markdown feature

Usage (from repo root, backend venv):
  .venv/bin/python mobile/scripts/bench/export_bench.py [--out DIR]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO))

import aiosqlite  # noqa: E402

from app.web_operations import frame_public, operation_public  # noqa: E402
from app.web_console.operation_store import WebAdminOperationsMixin  # noqa: E402
from app.web_console.chat_state import WebAdminChatStateMixin  # noqa: E402

DB_PATH = REPO / "data" / "openbear.db"

# Longest conversations by operation count (supplied by the controller).
BENCH_CONVERSATIONS = [
    "a6a877ad-298a-4270-a444-ce4c2b5c292b",
    "fed2ce26-0699-4ba0-a989-6c512fc1b16b",
    "d8e18cc9-d50b-48b3-b44a-0e8b107de4ca",
]
# A real visible streaming turn (assistant + reasoning appends, a few tools, ~150s).
STREAM_SAMPLES = [
    {"name": "deploy-path-analysis", "conversationUuid": "1ac535d0-64cd-4766-9531-250640d4125c",
     "turnUuid": "aaad9a75-1b82-47ed-9656-561e661a3859"},
    {"name": "single-user-instance", "conversationUuid": "1ac535d0-64cd-4766-9531-250640d4125c",
     "turnUuid": "39b38e97-37e0-4d47-aeea-d57dfdec94d6"},
]
PAGE_LIMITS = [200, 50]
DETAIL_TYPES = ("tool", "user_interaction", "context_compaction", "reasoning")


class ReadOnlyDB:
    def __init__(self, conn: aiosqlite.Connection) -> None:
        self.conn = conn


class BenchHost(WebAdminOperationsMixin, WebAdminChatStateMixin):
    """Just enough host state for the backend's read paths."""

    def __init__(self, db: ReadOnlyDB) -> None:
        self.db = db
        self._web_operation_locks: dict[str, asyncio.Lock] = {}

    def _web_operation_lock(self, conversation_uuid: str) -> asyncio.Lock:
        key = str(conversation_uuid or "")
        lock = self._web_operation_locks.get(key)
        if lock is None:
            lock = self._web_operation_locks[key] = asyncio.Lock()
        return lock


def dump(path: Path, value: Any) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    path.write_text(data, encoding="utf-8")
    return len(data.encode("utf-8"))


async def conversation_row(conn: aiosqlite.Connection, uuid: str) -> dict[str, Any]:
    cur = await conn.execute("SELECT * FROM web_conversations WHERE conversation_uuid=?", (uuid,))
    row = await cur.fetchone()
    if row is None:
        raise SystemExit(f"conversation not found: {uuid}")
    return dict(row)


def conversation_json(row: dict[str, Any], operation_count: int) -> dict[str, Any]:
    # Same keys as WebAdminConversationsMixin._web_conversation_json for an idle conversation.
    # (Live-run fields need a running backend; the bench is a historical snapshot.)
    from app.web_console.activity import activity_fields
    return {
        "conversationUuid": str(row.get("conversation_uuid") or ""),
        "ownerChatId": int(row.get("owner_chat_id") or 0),
        "internalChatId": int(row.get("internal_chat_id") or 0),
        "title": str(row.get("title") or "新对话"),
        "model": str(row.get("model") or ""),
        **activity_fields(row),
        "agentModel": str(row.get("agent_model") or ""),
        "contextStrategy": str(row.get("context_strategy") or "sliding_window"),
        "status": "idle",
        "currentStatus": str(row.get("current_status") or "就绪"),
        "running": False,
        "lastError": str(row.get("last_error") or ""),
        "createdAt": int(row.get("created_at") or 0),
        "updatedAt": int(row.get("updated_at") or 0),
        "pinnedAt": int(row.get("pinned_at") or 0),
        "pinned": int(row.get("pinned_at") or 0) > 0,
        "folderId": str(row.get("folder_uuid") or ""),
        "origin": str(row.get("origin_kind") or "user"),
        "archivedAt": int(row.get("archived_at") or 0),
        "archived": int(row.get("archived_at") or 0) > 0,
        "messageCount": int(row.get("message_count") or 0),
        "costUsd": float(row.get("cost_usd") or 0.0),
        "benchOperationCount": operation_count,
    }


async def export_conversation(host: BenchHost, out: Path, uuid: str) -> dict[str, Any]:
    conn = host.db.conn
    row = await conversation_row(conn, uuid)
    chat_id = int(row["internal_chat_id"] or 0)
    conv_dir = out / "conv" / uuid
    t0 = time.time()

    # Full summary snapshot (what GET /operations without timelineLimit returns).
    operations = await host._web_operations(uuid, include_tool_details=False)
    operations = await host._project_context_compaction_operations(chat_id, uuid, operations, include_tool_details=False)
    sizes = {"operations.json": dump(conv_dir / "operations.json", operations)}

    # Backend page chains, exactly as /state?timelineLimit=N and /operations?beforeDisplaySeq=S produce them.
    chains: dict[str, Any] = {}
    for limit in PAGE_LIMITS:
        chain = []
        before: int | None = None
        while True:
            async with host._web_operation_lock(uuid):
                ops, page = await host._web_operations_page(uuid, limit=limit, before_display_seq=before, include_tool_details=False)
            ops = await host._project_context_compaction_operations(chat_id, uuid, ops, include_tool_details=False, timeline_page=page)
            chain.append({
                "beforeDisplaySeq": before,
                "operations": ops,
                "hasMoreBefore": bool(page.get("hasMoreBefore")),
                "nextBeforeDisplaySeq": page.get("nextBeforeDisplaySeq"),
                "timelineLimit": page.get("timelineLimit"),
                "hasAnyOperations": bool(page.get("hasAnyOperations")),
            })
            if not page.get("hasMoreBefore"):
                break
            before = int(page["nextBeforeDisplaySeq"])
        sizes[f"pages-{limit}.json"] = dump(conv_dir / f"pages-{limit}.json", chain)
        chains[str(limit)] = {"pages": len(chain), "firstPageOps": len(chain[0]["operations"]) if chain else 0}

    frames = await host._web_frames(uuid, after_frame_seq=0, limit=1_000_000)
    sizes["frames.json"] = dump(conv_dir / "frames.json", frames)

    # Full detail snapshots for the detail endpoint (tool args/results, reasoning text).
    cur = await conn.execute(
        """
        SELECT operations.*, (
          SELECT MIN(frame.created_at_ms) FROM web_event_frames AS frame
          WHERE frame.conversation_uuid=? AND frame.op_id=operations.op_id
            AND frame.action IN ('end','error','cancel','stop')
        ) AS terminal_at_ms
        FROM web_operations AS operations
        WHERE operations.conversation_uuid=? AND operations.op_type IN (?,?,?,?)
        ORDER BY operations.display_seq, operations.id
        """,
        (uuid, uuid, *DETAIL_TYPES),
    )
    detail_path = conv_dir / "details.jsonl"
    detail_count = 0
    with detail_path.open("w", encoding="utf-8") as handle:
        async for item in cur:
            public = operation_public(dict(item), include_tool_details=True)
            handle.write(json.dumps(public, ensure_ascii=False, separators=(",", ":")) + "\n")
            detail_count += 1
    sizes["details.jsonl"] = detail_path.stat().st_size

    cur = await conn.execute("SELECT COALESCE(MAX(frame_seq),0) AS s FROM web_event_frames WHERE conversation_uuid=?", (uuid,))
    frame_seq = int((await cur.fetchone())["s"] or 0)
    state_base = {
        "ok": True,
        "chatId": chat_id,
        "conversationUuid": uuid,
        "running": False,
        "backgroundRunning": False,
        "backgroundTasks": [],
        "live": {},
        "operationSource": "web_operations",
        "frameSeq": frame_seq,
        "conversation": conversation_json(row, len(operations)),
        "model": str(row.get("model") or ""),
        "messages": [],
        "pendingConfirmations": [],
        "pendingSteering": [],
    }
    dump(conv_dir / "state-base.json", state_base)
    return {
        "conversationUuid": uuid,
        "title": state_base["conversation"]["title"],
        "operationCount": len(operations),
        "frameCount": len(frames),
        "frameSeq": frame_seq,
        "detailCount": detail_count,
        "pageChains": chains,
        "bytes": sizes,
        "exportSeconds": round(time.time() - t0, 2),
    }


async def export_stream(host: BenchHost, out: Path, sample: dict[str, str]) -> dict[str, Any]:
    conn = host.db.conn
    uuid, turn = sample["conversationUuid"], sample["turnUuid"]
    cur = await conn.execute(
        """SELECT * FROM web_event_frames WHERE conversation_uuid=?
           AND COALESCE(NULLIF(run_root_turn_uuid,''), turn_uuid)=? ORDER BY frame_seq""",
        (uuid, turn),
    )
    frames = [frame_public(dict(item)) for item in await cur.fetchall()]
    if not frames:
        raise SystemExit(f"no frames for stream sample {sample}")
    start = frames[0]["createdAtMs"]
    counts: dict[str, int] = {}
    for frame in frames:
        frame["replayOffsetMs"] = int(frame["createdAtMs"]) - int(start)
        key = f"{frame['opType']}:{frame['action']}"
        counts[key] = counts.get(key, 0) + 1
    dump(out / "stream" / f"{sample['name']}.json", {**sample, "frames": frames})
    return {**sample, "frameCount": len(frames), "durationMs": frames[-1]["replayOffsetMs"], "actions": counts}


CORPUS_PATTERNS = {
    "cjk_emphasis": re.compile(r"\*\*[^*\n]*[\u3000-\u303f\uff00-\uffef][^*\n]*\*\*[\u4e00-\u9fff]"),
    "code_fence": re.compile(r"^```[a-zA-Z]+", re.M),
    "table": re.compile(r"^\|[^\n]+\|\n\|[ :\-|]+\|", re.M),
    "math": re.compile(r"\$\$[^$]+\$\$|\\\(|\$[^$\n]{2,40}\$"),
    "link": re.compile(r"\[[^\]]+\]\((https?://|/)[^)]+\)"),
    "blockquote": re.compile(r"^> ", re.M),
    "task_list": re.compile(r"^- \[[ x]\] ", re.M),
    "heading": re.compile(r"^#{1,4} ", re.M),
}


async def export_corpus(conn: aiosqlite.Connection, out: Path) -> dict[str, int]:
    corpus: dict[str, list[dict[str, Any]]] = {key: [] for key in CORPUS_PATTERNS}
    cur = await conn.execute(
        """SELECT conversation_uuid, op_id, json_extract(payload_json,'$.text') AS text FROM web_operations
           WHERE op_type='assistant_message' AND COALESCE(json_extract(payload_json,'$.internal'),0)=0
             AND json_type(payload_json,'$.text')='text' AND length(json_extract(payload_json,'$.text')) BETWEEN 200 AND 6000
           ORDER BY id DESC LIMIT 20000"""
    )
    async for item in cur:
        text = str(item["text"] or "")
        for key, pattern in CORPUS_PATTERNS.items():
            if len(corpus[key]) < 6 and pattern.search(text):
                corpus[key].append({"conversationUuid": item["conversation_uuid"], "opId": item["op_id"], "text": text})
        if all(len(v) >= 6 for v in corpus.values()):
            break
    dump(out / "markdown-corpus.json", corpus)
    return {key: len(value) for key, value in corpus.items()}


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=os.path.join(os.environ.get("OPENBEAR_MOBILE_DATA") or os.path.expanduser("~/.cache/openbear-mobile"), "bench"))
    parser.add_argument("--db", default=str(DB_PATH))
    args = parser.parse_args()
    out = Path(args.out)
    if REPO in out.resolve().parents:
        raise SystemExit("refusing to write bench data inside the repository")
    out.mkdir(parents=True, exist_ok=True)

    # Read-only URI: SQLite rejects every write on this connection.
    conn = await aiosqlite.connect(f"file:{args.db}?mode=ro", uri=True)
    conn.row_factory = aiosqlite.Row
    try:
        cur = await conn.execute("PRAGMA query_only=1")
        await cur.close()
        host = BenchHost(ReadOnlyDB(conn))
        manifest: dict[str, Any] = {"exportedAtMs": int(time.time() * 1000), "source": "openbear.db (mode=ro)",
                                    "conversations": [], "streams": []}
        for uuid in BENCH_CONVERSATIONS:
            info = await export_conversation(host, out, uuid)
            print(json.dumps(info, ensure_ascii=False), flush=True)
            manifest["conversations"].append(info)
        for sample in STREAM_SAMPLES:
            info = await export_stream(host, out, sample)
            print(json.dumps(info, ensure_ascii=False), flush=True)
            manifest["streams"].append(info)
        manifest["markdownCorpus"] = await export_corpus(conn, out)
        print(json.dumps(manifest["markdownCorpus"]), flush=True)
        dump(out / "manifest.json", manifest)
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
