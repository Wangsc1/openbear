"""Real isolated SQLite lifecycle, checkpoint, billing and reconnect tests."""
from __future__ import annotations

import pytest

from app.db.engine import DB, now_ts
from app.runtime.store import RuntimeStore


@pytest.fixture
async def store(tmp_path):
    db = DB(str(tmp_path / "runtime.sqlite"))
    await db.connect()
    try:
        yield RuntimeStore(db)
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_run_terminal_and_stable_identity(store):
    run = await store.begin_run("agent:a", run_id="r", task_uuid="t", metadata={"label": "short"})
    assert run == await store.begin_run("agent:a", run_id="r", task_uuid="t", metadata={"label": "short"})
    with pytest.raises(ValueError):
        await store.begin_run("agent:b", run_id="r", task_uuid="t")
    await store.transition(run, "waiting", phase="approval")
    assert (await store.get_run(run))["revision"] == 1
    await store.transition(run, "completed", phase="done", detail={"result_ref": "ctx:1"})
    await store.transition(run, "completed", phase="done", detail={"result_ref": "ctx:1"})
    assert (await store.get_run(run))["revision"] == 2
    assert await store.begin_run("agent:a", run_id="r", task_uuid="t", metadata={"label": "short"}) == run
    with pytest.raises(ValueError):
        await store.transition(run, "running")
    with pytest.raises(ValueError):
        await store.begin_action(run, "tool")
    with pytest.raises(ValueError):
        await store.enqueue_command(run, kind="input")
    with pytest.raises(ValueError):
        await store.enqueue_command(run, kind="stop", command_id="late-stop")
    with pytest.raises(ValueError):
        await store.transition(run, "invalid")


@pytest.mark.asyncio
async def test_action_result_replay_conflict_and_no_reactivation(store):
    run = await store.begin_run("controller:s")
    action = await store.begin_action(run, "tool", action_id="a", call_id="call-1", name="Read", detail={"target_ref": "artifact:1"})
    assert action == await store.begin_action(run, "tool", action_id="a", call_id="call-1", name="Read", detail={"target_ref": "artifact:1"})
    with pytest.raises(ValueError):
        await store.begin_action(run, "model", action_id="a")
    assert await store.finish_action(action, status="completed", result_ref="context:result", detail={"count": 1}) is True
    assert await store.finish_action(action, status="completed", result_ref="context:result", detail={"count": 1}) is False
    with pytest.raises(ValueError):
        await store.finish_action(action, status="failed", result_ref="context:result")
    assert await store.begin_action(run, "tool", action_id="a", call_id="call-1", name="Read", detail={"target_ref": "artifact:1"}) == action
    assert (await store.get_action(action))["status"] == "completed"
    assert (await store.actions(run))[0]["outcome"] == {"count": 1}
    for outcome in ("failed", "cancelled", "not_started", "unknown"):
        aid = await store.begin_action(run, "tool", action_id=f"out-{outcome}")
        assert await store.finish_action(aid, status=outcome)
        assert not await store.finish_action(aid, status=outcome)


@pytest.mark.asyncio
async def test_delivery_checkpoint_rollback_and_acknowledgement(store):
    run = await store.begin_run("controller:owner")
    cmd = await store.enqueue_command(run, command_id="c", kind="input", source_ref="messages:10", payload={"type": "text_ref"})
    assert cmd == await store.enqueue_command(run, command_id="c", kind="input", source_ref="messages:10", payload={"type": "text_ref"})
    with pytest.raises(ValueError):
        await store.enqueue_command(run, command_id="c", kind="stop")
    with pytest.raises(ValueError):
        await store.acknowledge_command(cmd)
    with pytest.raises(ValueError):
        await store.mark_delivered(cmd, checkpoint_revision=1)  # no checkpoint exists
    async with store.db.write_transaction(label="test-create-context") as conn:
        await conn.execute(
            "INSERT INTO context_windows(owner_key,owner_kind,revision,created_at,updated_at) VALUES (?,?,?,?,?)",
            ("controller:owner", "controller", 0, now_ts(), now_ts()),
        )
    with pytest.raises(ValueError):
        await store.mark_delivered(cmd, checkpoint_revision=1)  # cannot invent revision
    with pytest.raises(RuntimeError):
        async with store.db.write_transaction(label="test-checkpoint-rollback") as conn:
            await conn.execute("UPDATE context_windows SET revision=1 WHERE owner_key=?", ("controller:owner",))
            assert await store.mark_delivered(cmd, checkpoint_revision=1)
            assert (await store.pending_commands(run))[0]["status"] == "delivered"
            raise RuntimeError("checkpoint save failed")
    assert (await store.pending_commands(run))[0]["status"] == "received"
    async with store.db.write_transaction(label="test-checkpoint-save") as conn:
        await conn.execute("UPDATE context_windows SET revision=1 WHERE owner_key=?", ("controller:owner",))
        assert await store.mark_delivered(cmd, checkpoint_revision=1)
    assert not await store.mark_delivered(cmd, checkpoint_revision=1)
    with pytest.raises(ValueError):
        await store.mark_delivered(cmd, checkpoint_revision=2)
    assert (await store.pending_commands(run))[0]["checkpoint_revision"] == 1
    assert await store.acknowledge_command(cmd)
    assert not await store.acknowledge_command(cmd)
    assert await store.pending_commands(run) == []
    # A checkpoint that predates receipt does not prove delivery.
    stale = await store.enqueue_command(run, command_id="stale", kind="stop")
    with pytest.raises(ValueError):
        await store.mark_delivered(stale, checkpoint_revision=1)
    await store.transition(run, "cancelled")
    assert await store.enqueue_command(run, command_id="c", source_ref="messages:10", payload={"type": "text_ref"}) == cmd


@pytest.mark.asyncio
async def test_accounting_claim_is_one_transaction_with_ledger_and_outer_rollback(store):
    run = await store.begin_run("agent:a")
    model = await store.begin_action(run, "model", action_id="attempt:1")
    tool = await store.begin_action(run, "tool")
    with pytest.raises(ValueError):
        async with store.accounting_claim(tool):
            pass
    # Test a local stand-in for the already existing model_calls/aggregate tables.
    async with store.db.write_transaction(label="test-ledger-schema") as conn:
        await conn.execute("CREATE TABLE test_ledger (action_id TEXT PRIMARY KEY, tokens INTEGER)")
        await conn.execute("CREATE TABLE test_aggregate (tokens INTEGER NOT NULL)")
        await conn.execute("INSERT INTO test_aggregate(tokens) VALUES (0)")
    with pytest.raises(RuntimeError):
        async with store.accounting_claim(model) as first:
            assert first
            await store.db.conn.execute("INSERT INTO test_ledger VALUES (?,?)", (model, 5))
            await store.db.conn.execute("UPDATE test_aggregate SET tokens=tokens+5")
            raise RuntimeError("ledger failure")
    with pytest.raises(RuntimeError):
        async with store.db.write_transaction(label="test-outer-rollback"):
            async with store.accounting_claim(model) as first:
                assert first
                await store.db.conn.execute("INSERT INTO test_ledger VALUES (?,?)", (model, 5))
                await store.db.conn.execute("UPDATE test_aggregate SET tokens=tokens+5")
            raise RuntimeError("outer rollback")
    async with store.db.write_transaction(label="test-savepoint-rollback"):
        with pytest.raises(RuntimeError):
            async with store.db.write_transaction(label="test-inner-rollback"):
                async with store.accounting_claim(model) as first:
                    assert first
                    raise RuntimeError("savepoint rollback")
        async with store.accounting_claim(model) as first:
            assert first
            await store.db.conn.execute("INSERT INTO test_ledger VALUES (?,?)", (model, 5))
            await store.db.conn.execute("UPDATE test_aggregate SET tokens=tokens+5")
    async with store.accounting_claim(model) as first:
        assert not first
        if first:
            await store.db.conn.execute("UPDATE test_aggregate SET tokens=tokens+5")
    cur = await store.db.conn.execute("SELECT tokens FROM test_aggregate")
    assert (await cur.fetchone())[0] == 5
    cur = await store.db.conn.execute("SELECT count(*) FROM test_ledger")
    assert (await cur.fetchone())[0] == 1


@pytest.mark.asyncio
async def test_additive_schema_on_existing_database_without_runtime_tables(tmp_path):
    path = str(tmp_path / "legacy.sqlite")
    db = DB(path)
    await db.connect()
    async with db.write_transaction(label="test-legacy-fixture") as conn:
        await conn.execute(
            "INSERT INTO context_windows(owner_key,owner_kind,created_at,updated_at) VALUES (?,?,?,?)",
            ("agent:legacy", "agent", now_ts(), now_ts()),
        )
        for table in ("runtime_accounting_claims", "runtime_commands", "runtime_actions", "runtime_runs"):
            await conn.execute(f"DROP TABLE {table}")
    await db.close()
    db = DB(path)
    await db.connect()
    store = RuntimeStore(db)
    assert await store.begin_run("agent:legacy", run_id="new") == "new"
    cur = await db.conn.execute("SELECT revision FROM context_windows WHERE owner_key=?", ("agent:legacy",))
    assert (await cur.fetchone())[0] == 0
    await db.close()


@pytest.mark.asyncio
async def test_restart_unknown_terminal_unchanged_and_schema_reconnect(tmp_path):
    path = str(tmp_path / "old.sqlite")
    db = DB(path)
    await db.connect()
    store = RuntimeStore(db)
    open_run = await store.begin_run("agent:a", run_id="open")
    started = await store.begin_action(open_run, "tool", action_id="maybe-side-effect")
    finished = await store.begin_action(open_run, "model", action_id="known")
    await store.finish_action(finished, status="completed", result_ref="model_calls:3")
    ended = await store.begin_run("agent:b", run_id="terminal")
    await store.transition(ended, "failed")
    old_revision = (await store.get_run(ended))["revision"]
    await db.close()
    # Re-running additive schema against a populated DB must preserve all facts.
    db = DB(path)
    await db.connect()
    store = RuntimeStore(db)
    await store.interrupt_open_runs()
    await store.interrupt_open_runs()
    assert (await store.get_run(open_run))["status"] == "interrupted"
    assert (await store.get_run(open_run))["revision"] == 1
    assert (await store.get_action(started))["status"] == "unknown"
    assert (await store.get_action(finished))["result_ref"] == "model_calls:3"
    assert (await store.get_run(ended))["revision"] == old_revision
    assert (await store.get_run(ended))["status"] == "failed"
    assert await store.begin_action(open_run, "tool", action_id=started) == started
    with pytest.raises(ValueError):
        await store.finish_action(started, status="completed")
    with pytest.raises(ValueError):
        await store.begin_action(open_run, "tool", action_id="new")
    await db.close()
