"""Persist-first EventBus.

Every event is written to task_events with a per-task monotonic seq, then fanned
out in-process to WebSocket subscribers. Replay from the DB is therefore
authoritative: a reconnecting client asks for `after_seq` and misses nothing.

Channels: "global" (task summaries, status changes, approval badge, stats)
and "task:{id}" (full per-task event stream).
"""

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any

import aiosqlite

from .db import db

log = logging.getLogger(__name__)

QUEUE_MAX = 500  # per-subscriber; overflow triggers a resync message


def utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


class Subscriber:
    def __init__(self) -> None:
        self.queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=QUEUE_MAX)
        self.channels: set[str] = set()

    def offer(self, message: dict[str, Any]) -> None:
        try:
            self.queue.put_nowait(message)
        except asyncio.QueueFull:
            # Slow client (phone on bad signal). Drop everything and tell it to
            # re-fetch via REST; the persisted log is the source of truth.
            while not self.queue.empty():
                try:
                    self.queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
            try:
                self.queue.put_nowait({"type": "resync"})
            except asyncio.QueueFull:
                pass


class EventBus:
    def __init__(self) -> None:
        self._subscribers: set[Subscriber] = set()

    # -- subscriptions -------------------------------------------------------

    def add_subscriber(self) -> Subscriber:
        sub = Subscriber()
        self._subscribers.add(sub)
        return sub

    def remove_subscriber(self, sub: Subscriber) -> None:
        self._subscribers.discard(sub)

    # -- publishing ----------------------------------------------------------

    async def emit_task_event(self, task_id: str, type_: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Persist a task event with the next per-task seq, then fan out to
        task:{id} subscribers.

        The seq is computed and written in ONE atomic INSERT (a MAX(seq)+1 subquery
        feeds the same statement), so there is no read-then-write window a second
        writer could slip through. UNIQUE(task_id, seq) is the backstop: if two
        processes (both draining against the shared DB) pick the same seq, exactly
        one INSERT commits and the loser catches IntegrityError and recomputes on the
        next attempt. Bounded to 5 tries — 5 simultaneous cross-process losers on one
        task is not a real workload, so exhausting them is a real bug worth raising.
        The old per-process _seq_cache/_seq_lock couldn't see another process's seqs
        and raised an uncaught IntegrityError on that collision."""
        ts = utcnow()
        payload_json = json.dumps(payload)
        seq: int | None = None
        for _ in range(5):
            try:
                row = await db.execute_returning(
                    "INSERT INTO task_events (task_id, seq, ts, type, payload)"
                    " VALUES (:tid, (SELECT COALESCE(MAX(seq), 0) + 1 FROM task_events WHERE task_id = :tid),"
                    " :ts, :type, :payload) RETURNING seq",
                    {"tid": task_id, "ts": ts, "type": type_, "payload": payload_json},
                )
                seq = row["seq"] if row else None
                break
            except aiosqlite.IntegrityError:
                continue  # another writer took this seq — recompute MAX+1 and retry
        if seq is None:
            raise RuntimeError(f"could not allocate a task_events seq for {task_id} after 5 attempts")
        event = {"channel": f"task:{task_id}", "task_id": task_id, "seq": seq, "ts": ts, "type": type_, "payload": payload}
        self._fan_out(event)
        return event

    def publish_global(self, type_: str, payload: dict[str, Any]) -> None:
        """Ephemeral global message (task summary upserts, badges, stats ticks).

        Not persisted — clients hydrate global state via REST on connect.
        """
        self._fan_out({"channel": "global", "ts": utcnow(), "type": type_, "payload": payload})

    def publish_task(self, task_id: str, type_: str, payload: dict[str, Any]) -> None:
        """Ephemeral per-task message — fanned out to task:{id} but NOT persisted.

        For high-frequency streaming (ACP token deltas) that would bloat the event
        log; the final persisted assistant_text is authoritative on replay/reconnect,
        so a client that missed the deltas still gets the complete message.
        """
        self._fan_out({"channel": f"task:{task_id}", "task_id": task_id, "ts": utcnow(), "type": type_, "payload": payload})

    def _fan_out(self, message: dict[str, Any]) -> None:
        channel = message["channel"]
        for sub in list(self._subscribers):
            if channel in sub.channels:
                sub.offer(message)


bus = EventBus()
