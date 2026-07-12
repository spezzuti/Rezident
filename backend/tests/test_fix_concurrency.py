"""TRACK concurrency — regressions for three multi-instance/DB races.

Covers:
  * FIX 1 — _mark_orphans (task_manager.py) must NOT fail a task that went live
    during the sweep. A task whose started_at post-dates the sweep start (a
    just-launched run) and a locally-owned task (in self.running) are spared; a
    genuine orphan (started before the sweep, or a NULL-started queued leftover)
    is still failed.
  * FIX 2 — emit_task_event (events.py) retries a transient OperationalError
    ('database is locked') during cross-process write contention instead of
    failing a healthy task, while still retrying an IntegrityError seq collision
    and still raising if the lock never clears.
  * FIX 3 — _migrate / _split_statements (db.py): the rewritten, lock-serialized
    migrate path still boots a fresh DB to the latest schema, is a clean no-op when
    already current, and the splitter ignores semicolons inside string literals.

The project ships no pytest — run standalone with the venv python:

    backend/.venv/Scripts/python.exe backend/tests/test_fix_concurrency.py
"""

import asyncio
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ -> import agentos.*

import aiosqlite  # noqa: E402

from agentos.config import settings  # noqa: E402
from agentos.db import MIGRATIONS, _split_statements, db  # noqa: E402
from agentos.events import bus, utcnow  # noqa: E402
from agentos.task_manager import TaskManager  # noqa: E402


async def _fresh_db() -> str:
    tmp = tempfile.mkdtemp(prefix="fixconc-")
    settings.data_dir = Path(tmp)
    if db._conn is not None:
        await db.close()
    await db.connect()
    return tmp


async def _insert_task(task_id: str, status: str, started_at: str | None) -> None:
    await db.execute(
        "INSERT INTO tasks (id, title, prompt, status, created_at, started_at) VALUES (?,?,?,?,?,?)",
        (task_id, "T", "P", status, utcnow(), started_at),
    )


async def _status(task_id: str) -> str:
    row = await db.fetch_one("SELECT status FROM tasks WHERE id=?", (task_id,))
    return row["status"]


# ---- FIX 1: orphan sweep spares live tasks, still fails genuine orphans -------

async def test_mark_orphans_spares_live_task_fails_genuine_orphan():
    tmp = await _fresh_db()
    try:
        mgr = TaskManager()
        # genuine orphan from a dead instance: running, started well before the sweep.
        await _insert_task("orphan-old", "running", "2000-01-01T00:00:00.000Z")
        # queued leftover that never started (NULL started_at) — still an orphan.
        await _insert_task("orphan-queued", "queued", None)
        # went live DURING the sweep: started_at post-dates the sweep start (a value in
        # the future stands in for _launch's fresh COALESCE stamp) — must be spared.
        await _insert_task("fresh-running", "running", "2999-01-01T00:00:00.000Z")
        # locally owned (in self.running): excluded regardless of started_at.
        await _insert_task("owned-running", "running", "2000-01-01T00:00:00.000Z")
        mgr.running["owned-running"] = object()  # _mark_orphans reads only the keys

        await mgr._mark_orphans()

        assert await _status("orphan-old") == "failed", "a genuine running orphan must be failed"
        assert await _status("orphan-queued") == "failed", "a queued leftover must be failed"
        assert await _status("fresh-running") == "running", "a task live during the sweep must be spared"
        assert await _status("owned-running") == "running", "a locally-owned task must be spared"
    finally:
        await db.close()
        shutil.rmtree(tmp, ignore_errors=True)


# ---- FIX 2: emit retries a transient lock, keeps integrity retry, still raises -

async def test_emit_retries_on_operational_error():
    tmp = await _fresh_db()
    try:
        orig = db.execute_returning
        state = {"failed": False}

        async def flaky(sql, params=()):
            if not state["failed"] and "INSERT INTO task_events" in sql:
                state["failed"] = True
                raise aiosqlite.OperationalError("database is locked")
            return await orig(sql, params)

        db.execute_returning = flaky  # type: ignore[assignment]
        try:
            event = await bus.emit_task_event("tOP", "status_change", {"v": 1})
        finally:
            db.execute_returning = orig  # type: ignore[assignment]

        assert state["failed"], "the test must have injected one lock error"
        assert event["seq"] == 1, f"after the lock clears the emit still lands seq=1, got {event['seq']}"
        rows = await db.fetch_all("SELECT COUNT(*) AS n FROM task_events WHERE task_id='tOP'")
        assert rows[0]["n"] == 1, "exactly one row persisted despite the retried lock"
    finally:
        await db.close()
        shutil.rmtree(tmp, ignore_errors=True)


async def test_emit_still_retries_integrity_error():
    tmp = await _fresh_db()
    try:
        orig = db.execute_returning
        state = {"failed": False}

        async def flaky(sql, params=()):
            if not state["failed"] and "INSERT INTO task_events" in sql:
                state["failed"] = True
                raise aiosqlite.IntegrityError("UNIQUE constraint failed: task_events.task_id, task_events.seq")
            return await orig(sql, params)

        db.execute_returning = flaky  # type: ignore[assignment]
        try:
            event = await bus.emit_task_event("tINT", "status_change", {"v": 1})
        finally:
            db.execute_returning = orig  # type: ignore[assignment]

        assert state["failed"] and event["seq"] == 1, "the seq-collision retry behavior must be preserved"
    finally:
        await db.close()
        shutil.rmtree(tmp, ignore_errors=True)


async def test_emit_raises_after_persistent_operational_error():
    tmp = await _fresh_db()
    try:
        orig = db.execute_returning
        calls = {"n": 0}

        async def always_locked(sql, params=()):
            if "INSERT INTO task_events" in sql:
                calls["n"] += 1
                raise aiosqlite.OperationalError("database is locked")
            return await orig(sql, params)

        db.execute_returning = always_locked  # type: ignore[assignment]
        raised = False
        try:
            await bus.emit_task_event("tLOCK", "status_change", {"v": 1})
        except RuntimeError:
            raised = True
        finally:
            db.execute_returning = orig  # type: ignore[assignment]

        assert raised, "a lock that never clears must surface as RuntimeError, not hang or pass"
        assert calls["n"] == 5, f"the bounded retry must try exactly 5 times, got {calls['n']}"
    finally:
        await db.close()
        shutil.rmtree(tmp, ignore_errors=True)


# ---- FIX 3: migrate path boots fresh, no-ops when current; splitter is safe ---

async def test_fresh_connect_migrates_to_latest():
    tmp = await _fresh_db()
    try:
        cur = await db.conn.execute("PRAGMA user_version")
        version = (await cur.fetchone())[0]
        assert version == len(MIGRATIONS), f"fresh boot must reach v{len(MIGRATIONS)}, got v{version}"
        # tables from early and late migrations both landed
        for tbl in ("tasks", "task_events", "approvals", "devices", "knowledge_chunks"):
            row = await db.fetch_one("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (tbl,))
            assert row is not None, f"table {tbl} must exist after a full migrate"
        # columns added by later ALTER-TABLE migrations are present
        cols = {c["name"] for c in await db.fetch_all("PRAGMA table_info(tasks)")}
        assert {"scheduled_for", "roundtable", "integration_key"} <= cols, f"late columns missing: {cols}"
    finally:
        await db.close()
        shutil.rmtree(tmp, ignore_errors=True)


async def test_migrate_is_noop_when_current():
    tmp = await _fresh_db()
    try:
        before = (await (await db.conn.execute("PRAGMA user_version")).fetchone())[0]
        await db._migrate()  # already at latest — the loop's slice is empty, no writes
        after = (await (await db.conn.execute("PRAGMA user_version")).fetchone())[0]
        assert before == after == len(MIGRATIONS), "re-running migrate at head must be a clean no-op"
    finally:
        await db.close()
        shutil.rmtree(tmp, ignore_errors=True)


async def test_split_statements_ignores_semicolons_in_literals():
    script = "CREATE TABLE t (a TEXT);\nINSERT INTO t (a) VALUES ('x;y;z');\n"
    stmts = _split_statements(script)
    assert len(stmts) == 2, f"a ';' inside a string literal must not split, got {stmts}"
    assert stmts[1] == "INSERT INTO t (a) VALUES ('x;y;z');"
    # every real migration splits into individually-complete statements
    for migration in MIGRATIONS:
        for stmt in _split_statements(migration):
            ended = stmt if stmt.endswith(";") else stmt + ";"
            assert sqlite3.complete_statement(ended), f"not a single complete statement: {stmt[:60]!r}"


TESTS = [
    test_mark_orphans_spares_live_task_fails_genuine_orphan,
    test_emit_retries_on_operational_error,
    test_emit_still_retries_integrity_error,
    test_emit_raises_after_persistent_operational_error,
    test_fresh_connect_migrates_to_latest,
    test_migrate_is_noop_when_current,
    test_split_statements_ignores_semicolons_in_literals,
]


def main() -> int:
    failed = 0
    for t in TESTS:
        try:
            asyncio.run(t())
            print(f"PASS  {t.__name__}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            import traceback
            print(f"FAIL  {t.__name__}: {type(exc).__name__}: {exc}")
            traceback.print_exc()
    print(f"\n{len(TESTS) - failed}/{len(TESTS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
