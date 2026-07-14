"""Stock-crew seeding — companions exist when the runtimes do.

  - migration v20 seeds Nick Valentine on a fresh DB (idempotent by name)
  - the codex trio (ZAX/Robobrain/ED-E) seeds when the codex slot is enabled
  - the seed is ONE-SHOT: retiring a stock member sticks (no re-hire on boot)
  - with codex disabled, nothing seeds

The project ships no pytest — run standalone with the venv python:

    backend/.venv/Scripts/python.exe backend/tests/test_crew_seed.py
"""

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ -> import agentos.*
os.environ["AGENTOS_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("AGENTOS_TOKEN", "test")

from agentos import crew_seed  # noqa: E402
from agentos.db import db  # noqa: E402


async def _names() -> set:
    return {r["name"] for r in await db.fetch_all("SELECT name FROM agent_profiles")}


async def _set_codex_enabled(enabled: bool) -> None:
    await db.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ("integration:codex", json.dumps({"enabled": enabled, "transport": "codex-cli"})),
    )


async def scenario() -> None:
    await db.connect()  # migrates the fresh temp DB

    # migration v20: Nick joins the stock crew on a fresh install
    names = await _names()
    assert "Nick Valentine" in names, names

    # codex disabled -> the trio does NOT seed
    created = await crew_seed.ensure_codex_crew()
    assert created == 0, created
    assert "ZAX" not in await _names()

    # codex enabled -> the trio seeds once
    await _set_codex_enabled(True)
    created = await crew_seed.ensure_codex_crew()
    assert created == 3, created
    names = await _names()
    for n in ("ZAX", "Robobrain", "ED-E"):
        assert n in names, names

    # one-shot: a retired stock member is NOT re-hired
    await db.execute("DELETE FROM agent_profiles WHERE name = 'ZAX'")
    created = await crew_seed.ensure_codex_crew()
    assert created == 0, created
    assert "ZAX" not in await _names(), "retire must stick — the seed is one-shot"

    await db.close()


def main() -> int:
    try:
        asyncio.run(scenario())
        print("PASS  crew seed scenario (migration + codex trio + one-shot retire)")
        print("\n1/1 passed")
        return 0
    except AssertionError as exc:
        import traceback
        print(f"FAIL  crew seed scenario: {exc}")
        traceback.print_exc()
        print("\n0/1 passed")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
