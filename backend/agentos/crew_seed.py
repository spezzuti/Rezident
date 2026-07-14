"""Auto-recruit the stock GPT crew when Codex is recognized.

The user's mental model (correct one): connecting a runtime should STAFF it —
the OS recognizes claude/codex and the stock companions simply exist, no manual
recruiting. Claude's stock crew (and Nick Valentine) seed via DB migrations
because the claude CLI is a hard requirement of the app; the codex trio seeds
HERE, the first time the codex slot is enabled, because seeding codex-brained
crew on a machine with no codex would be a cabinet of dead buttons.

One-shot semantics: a settings flag marks the seed generation as done, so a
user who deliberately retires ZAX doesn't find him re-hired on every boot.
"""

import json
import logging
import uuid

from .db import db
from .events import utcnow

log = logging.getLogger(__name__)

_FLAG = "crew_seed:codex:v1"

CODEX_CREW = [
    {
        "name": "ZAX",
        "role": "Consulting mainframe · deep reasoning",
        "icon": "Ψ", "color": "#f0c14b", "model": "gpt-5.6-sol",
        "description": "A pre-war ZAX-series supercomputer. The consultant for the hardest calls.",
        "system_prompt_append": (
            "You are ZAX, Rezident's consulting mainframe. You are brought in for the hardest "
            "problems: architecture calls, tricky bugs, adversarial review of plans. Think deeply, "
            "disagree when warranted, and show your reasoning — the operator wants your "
            "independent judgment, not agreement."
        ),
    },
    {
        "name": "Robobrain",
        "role": "Analytical unit · code review",
        "icon": "☿", "color": "#a3a55b", "model": "gpt-5.6-terra",
        "description": "A Robobrain analysis unit — the grounded second pair of eyes on code and plans.",
        "system_prompt_append": (
            "You are ROBOBRAIN, Rezident's analytical review unit. You review code and plans for "
            "correctness and simplicity, catch what others hand-wave, and prefer boring solutions "
            "that work. Be concrete: name files, functions, and failure modes."
        ),
    },
    {
        "name": "ED-E",
        "role": "Eyebot scout · fast recon",
        "icon": "✦", "color": "#46c0e0", "model": "gpt-5.6-luna",
        "description": "A souped-up eyebot — quick questions, summaries, and first-pass recon at speed.",
        "system_prompt_append": (
            "You are ED-E, Rezident's eyebot scout. You handle quick questions, summaries, and "
            "first-pass recon at speed. Be brief, sharp, and honest about uncertainty; flag "
            "anything that deserves a deeper look."
        ),
    },
]


async def _flag_set() -> bool:
    try:
        row = await db.fetch_one("SELECT value FROM settings WHERE key = ?", (_FLAG,))
        return bool(row)
    except Exception:  # noqa: BLE001 — a read failure must never block boot
        return True  # fail closed: don't risk double-seeding


async def _set_flag() -> None:
    await db.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
        (_FLAG, json.dumps({"seeded_at": utcnow()})),
    )


async def ensure_codex_crew() -> int:
    """Recruit the stock GPT companions once, iff the codex slot is enabled.
    Safe to call from boot AND from the enable/login paths — it no-ops fast on
    the flag, skips names that already exist, and never raises."""
    try:
        if await _flag_set():
            return 0
        from .integrations import get_config

        if not (await get_config("codex")).get("enabled"):
            return 0
        existing = {
            (r["name"] or "").lower()
            for r in await db.fetch_all("SELECT name FROM agent_profiles")
        }
        created = 0
        for comp in CODEX_CREW:
            if comp["name"].lower() in existing:
                continue
            await db.execute(
                "INSERT INTO agent_profiles (id, name, description, system_prompt_append,"
                " allowed_tools, disallowed_tools, permission_mode, model, inject_memory,"
                " is_default, icon, color, role, integration_key)"
                " VALUES (?, ?, ?, ?, '[]', '[]', 'default', ?, 1, 0, ?, ?, ?, 'codex')",
                (str(uuid.uuid4()), comp["name"], comp["description"],
                 comp["system_prompt_append"], comp["model"], comp["icon"],
                 comp["color"], comp["role"]),
            )
            created += 1
        await _set_flag()
        if created:
            log.info("crew seed: recruited %d stock GPT companions onto the codex slot", created)
        return created
    except Exception:  # noqa: BLE001 — seeding is a nicety, never a boot risk
        log.warning("crew seed: codex crew seeding failed; will not retry this boot", exc_info=True)
        return 0
