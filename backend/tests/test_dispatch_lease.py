"""Unit tests for the dispatcher lease + atomic task claim.

Standalone (the project ships no pytest): run with the venv python

    backend/.venv/Scripts/python.exe backend/tests/test_dispatch_lease.py

Each test runs against a fresh temp data dir with a fake, hand-cranked clock
(monkeypatched agentos.lease._now) so takeover timing is deterministic. No real
subprocesses, no sleeping.
"""

import asyncio
import shutil
import sys
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ -> import agentos.*

from agentos import lease as lease_mod  # noqa: E402
from agentos.config import settings  # noqa: E402
from agentos.db import db  # noqa: E402
from agentos.lease import DispatchLease  # noqa: E402


class Clock:
    def __init__(self, t: float = 1000.0) -> None:
        self.t = t

    def advance(self, dt: float) -> None:
        self.t += dt


@asynccontextmanager
async def fresh_db():
    """Fresh temp data dir + reconnected DB + fake clock. Closes the DB BEFORE the
    temp dir is removed (Windows won't unlink an open sqlite file)."""
    tmp = tempfile.mkdtemp()
    settings.data_dir = Path(tmp)
    settings.dispatch_lease_ttl_seconds = 30
    if db._conn is not None:
        await db.close()
    await db.connect()
    clock = Clock()
    lease_mod._now = lambda: clock.t
    try:
        yield clock
    finally:
        await db.close()
        shutil.rmtree(tmp, ignore_errors=True)


# ---- tests -------------------------------------------------------------------

async def test_single_holder():
    async with fresh_db():
        a, b = DispatchLease(), DispatchLease()
        await a._tick()
        await b._tick()
        assert a.held is True, "first ticker must acquire"
        assert b.held is False, "second ticker must NOT acquire a fresh lease"


async def test_takeover_after_ttl():
    async with fresh_db() as clock:
        a, b = DispatchLease(), DispatchLease()
        await a._tick()
        assert a.held
        # within TTL, b cannot take over
        clock.advance(settings.dispatch_lease_ttl_seconds - 1)
        await b._tick()
        assert b.held is False, "b took over before the holder's heartbeat went stale"
        # past TTL with no renewal from a, b seizes it
        clock.advance(2)
        await b._tick()
        assert b.held is True, "b must seize a stale lease"
        await a._tick()  # a discovers it lost
        assert a.held is False, "a must observe the loss on its next tick"


async def test_renew_keeps_holder():
    async with fresh_db() as clock:
        a, b = DispatchLease(), DispatchLease()
        await a._tick()
        since = (await a.describe())["since"]
        for _ in range(4):
            clock.advance(settings.dispatch_lease_ttl_seconds // 3)
            await a._tick()
        assert a.held is True, "holder must keep the lease across renewals"
        assert (await a.describe())["since"] == since, "acquired_at must not change on renewal"
        await b._tick()
        assert b.held is False, "a renewing keeps b locked out"


async def test_on_acquire_fires_once_and_refires_after_loss():
    async with fresh_db() as clock:
        fires = {"n": 0}

        async def cb():
            fires["n"] += 1

        a = DispatchLease()
        a.on_acquire = cb
        b = DispatchLease()
        await a._tick()
        assert fires["n"] == 1, "on_acquire fires on first acquire"
        clock.advance(settings.dispatch_lease_ttl_seconds // 3)
        await a._tick()  # renewal — must NOT refire
        assert fires["n"] == 1, "renewal must not refire on_acquire"
        # b takes over → a loses
        clock.advance(settings.dispatch_lease_ttl_seconds + 1)
        await b._tick()
        await a._tick()
        assert a.held is False and fires["n"] == 1, "loss must not fire on_acquire"
        # a reacquires after b goes stale → refires
        clock.advance(settings.dispatch_lease_ttl_seconds + 1)
        await a._tick()
        assert a.held is True and fires["n"] == 2, "reacquire must refire on_acquire once"


async def test_release_is_immediate():
    async with fresh_db():
        a, b = DispatchLease(), DispatchLease()
        await a._tick()
        assert a.held
        await a._release()
        assert a.held is False
        # b acquires immediately — no need to wait out the TTL
        await b._tick()
        assert b.held is True, "a released the lease, so b takes it at once"


async def test_conditional_claim_single_winner():
    """The exact belt-and-suspenders claim SQL from TaskManager._launch: two
    writers race one queued task; exactly one flips it to running."""
    async with fresh_db():
        await db.execute("INSERT INTO tasks (id, title, prompt) VALUES (?, ?, ?)", ("t1", "T", "P"))
        claim = (
            "UPDATE tasks SET status='running', started_at=COALESCE(started_at, :now)"
            " WHERE id=:id AND status='queued' RETURNING id"
        )
        first = await db.execute_returning(claim, {"id": "t1", "now": "2026-01-01T00:00:00Z"})
        second = await db.execute_returning(claim, {"id": "t1", "now": "2026-01-01T00:00:00Z"})
        assert first is not None, "first writer must win the claim"
        assert second is None, "second writer must find nothing to claim"


async def test_standby_does_not_claim():
    """A standby (lease.held False) never launches queued work; a holder claims once."""
    async with fresh_db():
        from agentos.task_manager import manager

        await db.execute("INSERT INTO tasks (id, title, prompt) VALUES (?, ?, ?)", ("t1", "T", "P"))
        recorded: list[str] = []

        async def rec(task_id: str) -> None:
            recorded.append(task_id)
            # mirror the real claim's DB effect so the drain loop terminates
            await db.execute("UPDATE tasks SET status='running' WHERE id=?", (task_id,))

        orig_launch = manager._launch
        manager._launch = rec  # type: ignore[method-assign]
        try:
            lease_mod.lease.held = False
            await manager._drain_queue()
            assert recorded == [], "a standby must not claim queued tasks"

            lease_mod.lease.held = True
            await manager._drain_queue()
            assert recorded == ["t1"], f"holder must claim the queued task exactly once, got {recorded}"
        finally:
            manager._launch = orig_launch  # type: ignore[method-assign]
            lease_mod.lease.held = False


async def test_sweep_excludes_own_running():
    """The orphan sweep fires on EVERY takeover (on_acquire), while this process may
    already be running tasks/chats. It must fail only work left by a PREVIOUS process,
    never our own live tasks or their pending approvals."""
    async with fresh_db():
        from agentos.task_manager import RunningTask, manager

        # 'own' — actively running HERE (in manager.running); chats bypass the gate
        await db.execute("INSERT INTO tasks (id, title, prompt, status) VALUES (?,?,?,?)",
                         ("own", "Owned", "P", "running"))
        await db.execute("INSERT INTO approvals (id, task_id, tool_name, status) VALUES (?,?,?,?)",
                         ("ap-own", "own", "Bash", "pending"))
        # 'stale' — left active by a dead process, present in the DB only
        await db.execute("INSERT INTO tasks (id, title, prompt, status) VALUES (?,?,?,?)",
                         ("stale", "Stale", "P", "running"))
        await db.execute("INSERT INTO approvals (id, task_id, tool_name, status) VALUES (?,?,?,?)",
                         ("ap-stale", "stale", "Bash", "pending"))

        # stub a RunningTask-like entry — the sweep only reads self.running's keys
        manager.running["own"] = RunningTask("own", object(), kind="chat")  # type: ignore[arg-type]
        try:
            await manager._mark_orphans()
        finally:
            manager.running.pop("own", None)

        own = await db.fetch_one("SELECT status FROM tasks WHERE id='own'")
        stale = await db.fetch_one("SELECT status FROM tasks WHERE id='stale'")
        ap_own = await db.fetch_one("SELECT status FROM approvals WHERE id='ap-own'")
        ap_stale = await db.fetch_one("SELECT status FROM approvals WHERE id='ap-stale'")
        assert own["status"] == "running", "our own running task must be untouched"
        assert ap_own["status"] == "pending", "our own task's approval must stay pending"
        assert stale["status"] == "failed", "a previous process's task must be swept to failed"
        assert ap_stale["status"] == "cancelled", "the stale task's approval must be cancelled"


async def test_callback_retry():
    """on_acquire is set-held-BEFORE-await; if it raises (e.g. transient DB lock) the
    renewal loop swallows it. A pending flag must retry it on the next tick and let it
    complete exactly once per hold (never refiring on later renewals)."""
    async with fresh_db() as clock:
        calls = {"attempts": 0, "completed": 0}

        async def cb():
            calls["attempts"] += 1
            if calls["attempts"] == 1:
                raise RuntimeError("database is locked")
            calls["completed"] += 1

        a = DispatchLease()
        a.on_acquire = cb
        try:
            await a._tick()  # acquires; callback raises (renewal loop would log it)
        except RuntimeError:
            pass
        assert a.held is True, "acquire still holds even though the callback raised"
        assert calls == {"attempts": 1, "completed": 0}
        assert a._callback_pending is True, "a failed callback must stay armed for retry"

        clock.advance(settings.dispatch_lease_ttl_seconds // 3)
        await a._tick()  # renewal tick — the pending flag drives a retry, now succeeds
        assert calls == {"attempts": 2, "completed": 1}, "must retry and complete once"
        assert a._callback_pending is False, "a clean completion disarms the retry"

        for _ in range(3):
            clock.advance(settings.dispatch_lease_ttl_seconds // 3)
            await a._tick()
        assert calls["completed"] == 1, "callback must fire exactly once per hold"


async def test_scheduler_reasserts_lease():
    """A superseded process with a stale cached held=True must not double-fire a
    schedule. scheduler.fire re-asserts the lease at the DB (lease._tick) before
    creating a task; a superseded holder flips to held=False and fires nothing."""
    async with fresh_db():
        from agentos.scheduler import scheduler

        b = DispatchLease()
        await b._tick()
        assert b.held, "B genuinely holds the lease in the DB"

        a = DispatchLease()
        a.held = True  # A is superseded but still BELIEVES it holds it (stale cache)

        await db.execute(
            "INSERT INTO schedules (id, name, cron_expr, task_template, enabled, next_run_at)"
            " VALUES (?,?,?,?,1,?)",
            ("s1", "nightly", "* * * * *", "{}", "2000-01-01T00:00:00.000Z"),
        )
        row = await db.fetch_one("SELECT * FROM schedules WHERE id='s1'")

        orig = lease_mod.lease
        lease_mod.lease = a  # the scheduler consults the process-wide singleton
        try:
            result = await scheduler.fire(dict(row), scheduled=True)
        finally:
            lease_mod.lease = orig

        assert a.held is False, "re-assert must flip the superseded process's held to False"
        assert result is None, "a superseded scheduled fire must not create a task"
        n = await db.fetch_one("SELECT COUNT(*) AS n FROM tasks")
        assert n["n"] == 0, "no paid task may be created by the superseded fire"


async def test_describe_degrades():
    """The readiness endpoint (desktop boot gate) and the Setup dispatcher row both
    read the lease from the DB. A DB error must degrade, never raise/500."""
    async with fresh_db():
        from agentos.api.system import readiness as readiness_endpoint
        from agentos.environment import _dispatcher_row

        async def boom(*_a, **_k):
            raise RuntimeError("database is locked")

        orig = db.fetch_one
        db.fetch_one = boom  # type: ignore[assignment]
        try:
            data = await readiness_endpoint()
            row = await _dispatcher_row()
        finally:
            db.fetch_one = orig  # type: ignore[assignment]

        disp = data["dispatcher"]
        assert disp.get("error") == "unavailable", f"degraded readiness payload expected, got {disp}"
        assert disp["held"] is None and disp["alive"] is False, "degraded payload shape"
        assert row["ok"] is True and row["detail"] == "unknown", "dispatcher row degrades, stays ok"


# ---- runner ------------------------------------------------------------------

TESTS = [
    test_single_holder,
    test_takeover_after_ttl,
    test_renew_keeps_holder,
    test_on_acquire_fires_once_and_refires_after_loss,
    test_release_is_immediate,
    test_conditional_claim_single_winner,
    test_standby_does_not_claim,
    test_sweep_excludes_own_running,
    test_callback_retry,
    test_scheduler_reasserts_lease,
    test_describe_degrades,
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
