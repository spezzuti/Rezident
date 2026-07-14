"""Roundtable participant resolution for BRAINED profiles (the ZAX field bug:
every roundtable turn of a codex-brained companion errored because the profile
was treated as local Claude and the claude CLI got handed gpt-5.6-sol).

  - a brained profile routes its turns over its integration (integration_key set)
    while KEEPING its persona, name, and model
  - an unbrained profile stays on the local-Claude path
  - a raw integration seat is untouched

The project ships no pytest — run standalone with the venv python:

    backend/.venv/Scripts/python.exe backend/tests/test_roundtable_brains.py
"""

import asyncio
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ -> import agentos.*
os.environ["AGENTOS_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("AGENTOS_TOKEN", "test")

from agentos.db import db  # noqa: E402
from agentos.roundtable import _resolve_personas  # noqa: E402


async def scenario() -> None:
    await db.connect()
    try:
        await _scenario_body()
    finally:
        # ALWAYS close: a failed assertion that skips close() leaves aiosqlite's
        # non-daemon thread alive — the process hangs with its output buffered
        # (observed: seven zombie test runs with empty logs)
        await db.close()


async def _scenario_body() -> None:
    # NON-STOCK names: a fresh DB's migrations seed the stock crew, so 'ZAX'
    # or 'Eyebot' here would trip the UNIQUE(name) constraint
    await db.execute(
        "INSERT INTO agent_profiles (id, name, description, system_prompt_append, allowed_tools,"
        " disallowed_tools, permission_mode, model, inject_memory, is_default, icon, color, role, integration_key)"
        " VALUES ('p-brained', 'BrainedBot', '', 'You are BrainedBot.', '[]', '[]', 'default', 'gpt-5.6-sol', 1, 0, 'Ψ', '#f0c14b', '', 'codex')",
    )
    await db.execute(
        "INSERT INTO agent_profiles (id, name, description, system_prompt_append, allowed_tools,"
        " disallowed_tools, permission_mode, model, inject_memory, is_default, icon, color, role, integration_key)"
        " VALUES ('p-plain', 'PlainBot', '', 'You are PlainBot.', '[]', '[]', 'default', 'sonnet', 1, 0, '◎', '#5fa8a0', '', NULL)",
    )

    parts = [
        {"profile_id": "p-brained", "integration_key": None, "name": "", "model": None, "color": "#7fc8ff"},
        {"profile_id": "p-plain", "integration_key": None, "name": "", "model": None, "color": "#7fc8ff"},
        {"profile_id": None, "integration_key": "marcus", "name": "Marcus", "model": None, "color": "#34e2ff"},
    ]
    await _resolve_personas(parts)

    brained, plain, marcus = parts
    assert brained["integration_key"] == "codex", "brained profile must route over its integration"
    assert brained["model"] == "gpt-5.6-sol" and brained["name"] == "BrainedBot", brained
    assert brained["persona"].startswith("You are BrainedBot"), "the brained persona must ride along"
    assert plain["integration_key"] is None, "unbrained profile stays on local Claude"
    assert plain["model"] == "sonnet", plain
    assert marcus["integration_key"] == "marcus" and marcus["agent_key"] == "integration:marcus", marcus


def main() -> int:
    try:
        asyncio.run(scenario())
        print("PASS  roundtable brained-profile routing")
        print("\n1/1 passed")
        return 0
    except AssertionError as exc:
        import traceback
        print(f"FAIL  roundtable brained-profile routing: {exc}")
        traceback.print_exc()
        print("\n0/1 passed")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
