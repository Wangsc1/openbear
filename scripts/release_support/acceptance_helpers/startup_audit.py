"""Acceptance-only observers, installed before app.main via sitecustomize.

Never bypass readiness, suppress SQL, or change startup/retention scheduling.
The SQLite authorizer records DELETE attempts (including CTEs and triggers) and
always allows the original SQL. No SQL text, payload or credentials are logged.
"""
from __future__ import annotations

import functools
import importlib.machinery
import json
import os
import pathlib
import sqlite3
import sys
import threading
import time
import uuid


def install(output):
    output = pathlib.Path(output)
    started = time.monotonic()
    boot = uuid.uuid4().hex
    lock = threading.Lock()

    def emit(event, **fields):
        row = {"event": event, "pid": os.getpid(), "bootId": boot,
               "elapsedSeconds": time.monotonic() - started, **fields}
        with lock, output.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
            handle.flush()

    emit("observerInstalled")
    original_connect = sqlite3.connect

    @functools.wraps(original_connect)
    def connect(*args, **kwargs):
        connection = original_connect(*args, **kwargs)
        database = os.fspath(args[0] if args else kwargs["database"])
        if database != ":memory:" and not database.startswith("file:"):
            database = str(pathlib.Path(database).resolve())

        def authorize(action, table, column, db_name, trigger):
            if action == sqlite3.SQLITE_DELETE and str(table).lower() == "web_event_frames":
                emit("frameDeleteAttempt", database=database, trigger=trigger)
            return sqlite3.SQLITE_OK

        connection.set_authorizer(authorize)
        emit("sqliteObserved", database=database)
        return connection

    sqlite3.connect = connect
    # sqlite3.dbapi2 is another public import path used by older installations.
    sqlite3.dbapi2.connect = connect

    class ServicesLoader:
        def __init__(self, original):
            self.original = original

        def create_module(self, spec):
            return self.original.create_module(spec)

        def exec_module(self, module):
            self.original.exec_module(module)
            original = module.Services.startup

            @functools.wraps(original)
            async def startup(owner, *args, **kwargs):
                emit("startupEntered")
                try:
                    value = await original(owner, *args, **kwargs)
                except BaseException as exc:
                    emit("startupFailed", errorType=type(exc).__name__)
                    raise
                ready = getattr(owner, "startup_ready", None)
                emit("startupReturned", startupReady=bool(ready is not None and ready.is_set()))
                return value

            module.Services.startup = startup

    class ServicesFinder:
        def find_spec(self, fullname, path=None, target=None):
            if fullname != "app.services":
                return None
            spec = importlib.machinery.PathFinder.find_spec(fullname, path)
            if spec is not None and spec.loader is not None:
                spec.loader = ServicesLoader(spec.loader)
            return spec

    sys.meta_path.insert(0, ServicesFinder())


def verify_audit(rows, pid, *, max_ready_seconds=60.0, database=None):
    """Fail closed on missing instrumentation/barrier, crashes, deletes or delay."""
    events = [row for row in rows if str(row.get("pid")) == str(pid)]
    errors = []
    for event in ("observerInstalled", "startupEntered", "startupReturned"):
        if sum(row.get("event") == event for row in events) != 1:
            errors.append(f"expected exactly one {event} for service PID {pid}")
    if len({row.get("bootId") for row in events}) != 1:
        errors.append("ambiguous/missing service boot identity")
    connections = [row for row in events if row.get("event") == "sqliteObserved"]
    if not connections or (database is not None and not any(
            pathlib.Path(row["database"]).resolve() == pathlib.Path(database).resolve() for row in connections)):
        errors.append("no observed application SQLite connection")
    returned = [row for row in events if row.get("event") == "startupReturned"]
    if returned and (returned[0].get("startupReady") is not True
                     or not 0 <= returned[0]["elapsedSeconds"] <= max_ready_seconds):
        errors.append("startup_ready barrier missing/unset or readiness deadline exceeded")
    deletes = [row for row in events if row.get("event") == "frameDeleteAttempt"]
    if deletes:
        errors.append("web_event_frames DELETE attempted during startup/probe window")
    if any(row.get("event") == "startupFailed" for row in events):
        errors.append("Services.startup failed")
    return {"ok": not errors, "pid": str(pid), "bootId": events[0].get("bootId") if events else None,
            "readySeconds": returned[0]["elapsedSeconds"] if returned else None,
            "readyDeadlineSeconds": max_ready_seconds, "sqliteConnectionsObserved": len(connections),
            "frameDeleteAttempts": len(deletes), "errors": errors}
