"""TRACK runtime — regressions for the three liveness/correctness fixes in the
chat + roundtable run paths (runner.py / roundtable.py).

Covers:
  * send_user_message running->running is a NO-OP (uses the non-throwing
    _safe_transition path) instead of raising on an invalid transition.
  * send_user_message emits the user_message transcript line only AFTER the
    message is actually enqueued (integration chat) / handed to client.query
    (live SDK chat) — so a failed hand-off can't leave a phantom transcript line.
  * _park_for_message poll-parks: it returns a real follow-up, unwinds on the
    None cancel sentinel, AND unwinds on a cross-process cancel noticed via
    _should_stop() while the local queue stays empty.

The project ships no pytest — run standalone with the venv python:

    backend/.venv/Scripts/python.exe backend/tests/test_fix_runtime.py
"""

import asyncio
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ -> import agentos.*

from agentos.config import settings  # noqa: E402
from agentos.db import db  # noqa: E402
from agentos.events import bus, utcnow  # noqa: E402
from agentos.runner import AgentRunner  # noqa: E402
import agentos.runner as runner_mod  # noqa: E402


async def _fresh_db() -> str:
    tmp = tempfile.mkdtemp(prefix="fixruntime-")
    settings.data_dir = Path(tmp)
    if db._conn is not None:
        await db.close()
    await db.connect()
    return tmp


async def _insert_task(task_id: str, status: str) -> dict:
    await db.execute(
        "INSERT INTO tasks (id, title, prompt, status, created_at) VALUES (?,?,?,?,?)",
        (task_id, "T", "P", status, utcnow()),
    )
    return {"id": task_id, "title": "T", "prompt": "P", "status": status}


class _Recorder:
    """Swap in for bus.emit_task_event; records (kind, payload) and, for proof of
    emit-after-enqueue ordering, a caller-supplied probe evaluated AT emit time."""

    def __init__(self, probe=None) -> None:
        self.calls: list = []
        self._probe = probe

    async def __call__(self, task_id, kind, payload) -> None:
        self.calls.append((kind, payload, self._probe() if self._probe else None))


# ---- FIX 3: running->running is a no-op, and emit happens after enqueue -------

async def test_send_user_message_running_is_noop_and_emits_after_enqueue():
    tmp = await _fresh_db()
    orig_emit = bus.emit_task_event
    try:
        task = await _insert_task("r1", "running")
        runner = AgentRunner(task)
        runner._chat_queue = asyncio.Queue()  # integration-chat mode: no live client

        # probe: queue size AT emit time. put() runs before emit(), so if ordering
        # holds the queue already holds the message (qsize == 1) when we record.
        rec = _Recorder(probe=lambda: runner._chat_queue.qsize())
        bus.emit_task_event = rec

        # running->running must NOT raise (would, on the throwing transition path).
        await runner.send_user_message("hello")

        assert runner._chat_queue.qsize() == 1, "the follow-up must be enqueued"
        assert await runner._chat_queue.get() == "hello"
        assert len(rec.calls) == 1, f"exactly one transcript emit, got {rec.calls}"
        kind, payload, qsize_at_emit = rec.calls[0]
        assert kind == "user_message" and payload == {"text": "hello"}
        assert qsize_at_emit == 1, "user_message must be emitted AFTER the enqueue"

        # the task row must still be 'running' — the no-op didn't move it.
        row = await db.fetch_one("SELECT status FROM tasks WHERE id = ?", ("r1",))
        assert row["status"] == "running", f"status must stay running, got {row['status']}"
    finally:
        bus.emit_task_event = orig_emit
        await db.close()
        shutil.rmtree(tmp, ignore_errors=True)


async def test_send_user_message_live_client_emits_after_query():
    tmp = await _fresh_db()
    orig_emit = bus.emit_task_event
    try:
        task = await _insert_task("r2", "running")
        runner = AgentRunner(task)

        order: list[str] = []

        class _FakeClient:
            async def query(self, text):
                order.append("query")

            async def interrupt(self):
                pass

        runner.client = _FakeClient()
        runner._chat_queue = None  # live SDK chat path

        async def emit(task_id, kind, payload):
            order.append("emit")

        bus.emit_task_event = emit

        await runner.send_user_message("hi")
        assert order == ["query", "emit"], f"emit must follow client.query, got {order}"
    finally:
        bus.emit_task_event = orig_emit
        await db.close()
        shutil.rmtree(tmp, ignore_errors=True)


# ---- FIX 2: _park_for_message poll-parks ------------------------------------

async def test_park_returns_message_and_cancel_sentinel():
    task = {"id": "p1", "status": "running"}
    runner = AgentRunner(task)
    runner._chat_queue = asyncio.Queue()

    # a real follow-up is returned verbatim
    await runner._chat_queue.put("next turn")
    assert await runner._park_for_message() == "next turn"

    # the None sentinel (local cancel via request_interrupt) unwinds immediately
    await runner._chat_queue.put(None)
    assert await runner._park_for_message() is None


async def test_park_notices_remote_cancel_with_empty_queue():
    task = {"id": "p2", "status": "running"}
    runner = AgentRunner(task)
    runner._chat_queue = asyncio.Queue()  # stays empty — a remote cancel never puts here

    calls = {"n": 0}

    async def fake_should_stop():
        calls["n"] += 1
        return True  # simulate the durable row having left an active status

    runner._should_stop = fake_should_stop

    orig_interval = runner_mod._SELF_CHECK_INTERVAL
    runner_mod._SELF_CHECK_INTERVAL = 0.02  # keep the poll tight for the test
    try:
        result = await asyncio.wait_for(runner._park_for_message(), timeout=2.0)
    finally:
        runner_mod._SELF_CHECK_INTERVAL = orig_interval
    assert result is None, "a remote cancel with an empty queue must unwind the park"
    assert calls["n"] >= 1, "the poll must have run _should_stop at least once"


TESTS = [
    test_send_user_message_running_is_noop_and_emits_after_enqueue,
    test_send_user_message_live_client_emits_after_query,
    test_park_returns_message_and_cancel_sentinel,
    test_park_notices_remote_cancel_with_empty_queue,
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
