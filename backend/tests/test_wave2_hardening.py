"""Wave-2 security/correctness regression tests.

Standalone (the project ships no pytest): run with the venv python

    backend/.venv/Scripts/python.exe backend/tests/test_wave2_hardening.py

Covers:
  F1 — TaskManager.transition() is a compare-and-swap: two writers racing the same
       terminal edge yield exactly ONE winner, ONE set of side effects, and the DB
       ends in the winner's state; the loser emits nothing.
  F5 — first-launch token provisioning is race-safe: a second provisioner adopts
       the file's token, and settings.token always matches the file.
"""

import asyncio
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ -> import agentos.*

from agentos import config  # noqa: E402
from agentos.config import settings  # noqa: E402
from agentos.db import db  # noqa: E402


# ---- F1: terminal-transition compare-and-swap --------------------------------

async def test_transition_cas_single_winner():
    import agentos.memory as memory_mod
    from agentos import events
    from agentos.task_manager import manager

    tmp = tempfile.mkdtemp()
    settings.data_dir = Path(tmp)
    if db._conn is not None:
        await db.close()
    await db.connect()

    # count side effects instead of really firing them
    emits: list[tuple] = []
    globals_: list[tuple] = []
    episodes: list[str] = []

    async def fake_emit(task_id, type_, payload):
        emits.append((task_id, type_, payload))
        return {}

    def fake_publish(type_, payload):
        globals_.append((type_, payload))

    async def fake_add_episode(task):
        episodes.append(task["status"])

    orig_emit = events.bus.emit_task_event
    orig_pub = events.bus.publish_global
    orig_ep = memory_mod.add_episode
    events.bus.emit_task_event = fake_emit          # type: ignore[assignment]
    events.bus.publish_global = fake_publish        # type: ignore[assignment]
    memory_mod.add_episode = fake_add_episode       # type: ignore[assignment]
    try:
        await db.execute(
            "INSERT INTO tasks (id, title, prompt, status, started_at)"
            " VALUES (?, ?, ?, 'running', ?)",
            ("t1", "Race task", "P", events.utcnow()),
        )
        # a completion and a cancel both validate against 'running' and race the write
        results = await asyncio.gather(
            manager.transition("t1", "done"),
            manager.transition("t1", "cancelled"),
            return_exceptions=True,
        )
        # neither call may raise something other than the tolerated ValueError
        for r in results:
            assert r is None or isinstance(r, ValueError), f"unexpected error from transition: {r!r}"

        status_changes = [e for e in emits if e[1] == "status_change"]
        upserts = [g for g in globals_ if g[0] == "task_upsert"]
        assert len(status_changes) == 1, f"exactly one status_change must be emitted, got {status_changes}"
        assert len(upserts) == 1, f"exactly one task_upsert must be published, got {len(upserts)}"
        assert len(episodes) == 1, f"exactly one episode must be added, got {episodes}"

        winner = status_changes[0][2]["to"]
        assert winner in ("done", "cancelled"), winner
        assert episodes[0] == winner, "the episode must reflect the winning state"

        row = await db.fetch_one("SELECT status, finished_at FROM tasks WHERE id='t1'")
        assert row["status"] == winner, f"DB must end in the winner's state, got {row['status']}"
        assert row["finished_at"], "finished_at must be set on the terminal transition"
    finally:
        events.bus.emit_task_event = orig_emit      # type: ignore[assignment]
        events.bus.publish_global = orig_pub        # type: ignore[assignment]
        memory_mod.add_episode = orig_ep            # type: ignore[assignment]
        await db.close()
        shutil.rmtree(tmp, ignore_errors=True)


# ---- F5: first-launch token provisioning race --------------------------------

async def test_token_provisioning_race_safe():
    tmp = Path(tempfile.mkdtemp())
    orig_dir = settings.data_dir
    orig_tok = settings.token
    try:
        settings.data_dir = tmp
        settings.token = ""
        # first provisioner writes the file; settings.token matches it
        t1 = config.ensure_token()
        on_disk = (tmp / "token").read_text(encoding="utf-8").strip()
        assert t1 == on_disk and settings.token == on_disk, "single-launch token matches file"

        # a second provisioner (fresh settings.token) adopts the SAME file token —
        # it must never mint a new one or clobber the file
        settings.token = ""
        t2 = config.ensure_token()
        assert t2 == t1, "second provisioner must adopt the existing file token"
        assert (tmp / "token").read_text(encoding="utf-8").strip() == on_disk, "file must not be clobbered"

        # simulate a true race: a rival wins the exclusive create first; the loser
        # (this call) must adopt the winner's token, not overwrite it
        settings.token = ""
        (tmp / "token").unlink()
        rival = "RIVAL-TOKEN-abc123"
        (tmp / "token").write_text(rival, encoding="utf-8")  # rival won O_EXCL
        t3 = config.ensure_token()
        assert t3 == rival and settings.token == rival, "loser must adopt the winner's token"

        # a blank/corrupt file self-heals to a real token
        settings.token = ""
        (tmp / "token").write_text("   \n", encoding="utf-8")
        t4 = config.ensure_token()
        assert t4 and t4.strip() == t4 and settings.token == t4, "corrupt token self-heals"
        assert (tmp / "token").read_text(encoding="utf-8").strip() == t4, "healed token persisted"
    finally:
        settings.data_dir = orig_dir
        settings.token = orig_tok
        shutil.rmtree(tmp, ignore_errors=True)


# ---- runner ------------------------------------------------------------------

TESTS = [
    test_transition_cas_single_winner,
    test_token_provisioning_race_safe,
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
