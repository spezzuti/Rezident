"""Dispatcher lease: exactly one live process drains the task queue and fires
schedules against the shared SQLite DB.

Incident rationale: the boot service and a manually-launched instance can be
alive at once (different Windows sessions — the runtime.json HTTP probe guards
only a fresh `serve()`, never an already-running pair). Two dispatchers against
one DB double-launch paid runs. This lease makes queue draining and schedule
firing conditional on holding a single-row lock; a standby still serves
reads/writes and user-interactive chats, it just never claims queued work.

Identity is an opaque token (uuid4 hex), NOT the pid: pid is display-only and,
under the Windows venv launcher, must be this server child's own os.getpid().
Takeover is heartbeat-based — the holder renews every ttl//3s; a standby seizes
the row only once heartbeat is older than ttl. Constraints, not narration.
"""

import asyncio
import logging
import os
import socket
import time
import uuid
from datetime import datetime, timezone

from .config import settings
from .db import db

log = logging.getLogger(__name__)


def _now() -> float:
    """Wall clock in unix epoch seconds — the heartbeat/staleness source. Module
    level so tests can monkeypatch a fake clock (agentos.lease._now)."""
    return time.time()


def _iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


class DispatchLease:
    def __init__(self) -> None:
        self.token = uuid.uuid4().hex  # authoritative identity
        self.pid = os.getpid()  # display-only; the real server child under the launcher
        self.host = socket.gethostname()
        self.held = False
        self.on_acquire = None  # optional async callback, fired only on False->True
        self._callback_pending = False  # armed on the False->True edge, cleared only
        # once on_acquire returns without raising — so a callback that fails (e.g. a
        # transient 'database is locked' during the orphan sweep) is retried on the
        # next tick instead of being silently skipped for the whole hold.
        self._task: asyncio.Task | None = None

    @property
    def _ttl(self) -> int:
        return max(1, int(settings.dispatch_lease_ttl_seconds))

    async def start(self) -> None:
        await self._tick()  # try to grab the lease immediately at boot
        self._task = asyncio.create_task(self._renew_loop(), name="dispatch-lease")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        await self._release()

    async def _renew_loop(self) -> None:
        interval = max(1, self._ttl // 3)
        while True:
            try:
                await asyncio.sleep(interval)
                await self._tick()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 — a bad tick must never kill the loop
                log.exception("dispatch-lease tick failed")

    async def _tick(self) -> None:
        """One atomic acquire-or-renew. Win the row when it is unheld, ours, or
        stale; keep acquired_at across our own renewals, stamp it fresh on takeover."""
        now = _now()
        row = await db.execute_returning(
            "UPDATE dispatch_lease SET holder=:tok, pid=:pid, host=:host, heartbeat=:now,"
            " acquired_at=CASE WHEN holder=:tok THEN acquired_at ELSE :at END"
            " WHERE id=1 AND (holder IS NULL OR holder=:tok OR heartbeat < :cutoff)"
            " RETURNING holder",
            {"tok": self.token, "pid": self.pid, "host": self.host, "now": now,
             "at": _iso(), "cutoff": now - self._ttl},
        )
        won = row is not None and row["holder"] == self.token
        if won and not self.held:
            self.held = True
            self._callback_pending = True  # arm on_acquire for this False->True edge
            log.info("dispatch lease ACQUIRED (pid=%s)", self.pid)
        elif not won and self.held:
            self.held = False
            log.warning("dispatch lease LOST (pid=%s) — another instance took over", self.pid)
        # Fire (or RETRY) the acquire callback while we hold and it hasn't yet
        # completed cleanly. held is set BEFORE this await, so a raising callback
        # would otherwise be swallowed by the renewal loop and every later tick would
        # be a plain renewal — the sweep would never run for the whole hold. The
        # pending flag survives the raise (the clear below is skipped) and drives a
        # retry on the next tick. When on_acquire is None (the boot ordering, before
        # TaskManager wires it) we just disarm — manager.start runs the sweep itself.
        if won and self._callback_pending:
            if self.on_acquire is not None:
                await self.on_acquire()  # may raise -> pending stays True, retried next tick
            self._callback_pending = False

    async def _release(self) -> None:
        self.held = False
        await db.execute(
            "UPDATE dispatch_lease SET holder=NULL, pid=NULL, heartbeat=0 WHERE holder=:tok",
            {"tok": self.token},
        )

    async def describe(self) -> dict:
        """Surface for readiness / setup: whether THIS instance holds it, the pid
        of whoever currently holds it, since when, and whether that holder is alive."""
        row = await db.fetch_one(
            "SELECT holder, pid, acquired_at, heartbeat FROM dispatch_lease WHERE id=1"
        )
        if row is None:
            return {"held": False, "holder_pid": None, "since": None, "alive": False}
        alive = row["holder"] is not None and row["heartbeat"] > _now() - self._ttl
        return {
            "held": self.held,
            "holder_pid": row["pid"] if alive else None,
            "since": row["acquired_at"] if alive else None,
            "alive": alive,
        }


lease = DispatchLease()
