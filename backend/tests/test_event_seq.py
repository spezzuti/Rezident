"""Chunk B — collision-safe per-task event seq (#8).

emit_task_event used to read MAX(seq) into a per-PROCESS cache under a per-process
lock, then INSERT separately — a two-await, per-process-cache design that raised an
uncaught IntegrityError when a second process picked the same seq for one task. The
fix computes seq inside ONE atomic INSERT (MAX+1 subquery) with a bounded retry on
UNIQUE(task_id, seq) collision.

Standalone (the project ships no pytest): run with the venv python

    backend/.venv/Scripts/python.exe backend/tests/test_event_seq.py
"""

import asyncio
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ -> import agentos.*

import aiosqlite  # noqa: E402

from agentos.config import settings  # noqa: E402
from agentos.db import db  # noqa: E402
from agentos.events import bus, utcnow  # noqa: E402


async def _fresh_db():
    tmp = tempfile.mkdtemp(prefix="event-seq-")
    settings.data_dir = Path(tmp)
    if db._conn is not None:
        await db.close()
    await db.connect()
    return tmp


# ---- concurrent emits get unique, contiguous seqs ----------------------------

async def test_concurrent_emits_are_contiguous():
    tmp = await _fresh_db()
    try:
        n = 25
        events = await asyncio.gather(
            *(bus.emit_task_event("tX", "status_change", {"i": i}) for i in range(n))
        )
        seqs = sorted(e["seq"] for e in events)
        assert seqs == list(range(1, n + 1)), f"seqs must be 1..{n} unique/contiguous, got {seqs}"

        # and the DB agrees — no gaps, no dupes
        rows = await db.fetch_all("SELECT seq FROM task_events WHERE task_id='tX' ORDER BY seq")
        assert [r["seq"] for r in rows] == list(range(1, n + 1)), "persisted seqs match"
    finally:
        await db.close()
        shutil.rmtree(tmp, ignore_errors=True)


# ---- emit computes MAX+1 fresh, seeing rows this process never wrote ----------

async def test_emit_sees_preexisting_seq():
    tmp = await _fresh_db()
    try:
        # A row this process's emit path never handed out (as if written by ANOTHER
        # process). The old per-process cache would have started from 0 and collided;
        # the fresh MAX+1 lands on seq=2 with no raise.
        await db.execute(
            "INSERT INTO task_events (task_id, seq, ts, type, payload) VALUES (?, 1, ?, 'seed', '{}')",
            ("tY", utcnow()),
        )
        event = await bus.emit_task_event("tY", "status_change", {"ok": True})
        assert event["seq"] == 2, f"emit must compute MAX+1=2 over a pre-existing row, got {event['seq']}"
    finally:
        await db.close()
        shutil.rmtree(tmp, ignore_errors=True)


# ---- a real collision is retried, not raised ---------------------------------

async def test_collision_is_retried():
    tmp = await _fresh_db()
    try:
        # Force the FIRST atomic INSERT to raise IntegrityError (as a cross-process
        # loser would), then delegate to the real statement. The bounded retry must
        # recompute MAX+1 and succeed instead of surfacing the error.
        orig = db.execute_returning
        state = {"failed": False}

        async def flaky(sql, params=()):
            if not state["failed"] and "INSERT INTO task_events" in sql:
                state["failed"] = True
                raise aiosqlite.IntegrityError("UNIQUE constraint failed: task_events.task_id, task_events.seq")
            return await orig(sql, params)

        db.execute_returning = flaky  # type: ignore[assignment]
        try:
            event = await bus.emit_task_event("tZ", "status_change", {"v": 1})
        finally:
            db.execute_returning = orig  # type: ignore[assignment]

        assert state["failed"], "the test must have injected one collision"
        assert event["seq"] == 1, f"after retry the emit still lands seq=1, got {event['seq']}"
        rows = await db.fetch_all("SELECT COUNT(*) AS n FROM task_events WHERE task_id='tZ'")
        assert rows[0]["n"] == 1, "exactly one row persisted despite the retried collision"
    finally:
        await db.close()
        shutil.rmtree(tmp, ignore_errors=True)


TESTS = [
    test_concurrent_emits_are_contiguous,
    test_emit_sees_preexisting_seq,
    test_collision_is_retried,
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
