"""Model-availability watch — subscription models come and go, and a companion
whose brain has left the building must GRACEFULLY VANISH rather than sit on the
roster as a dead button.

When a local Claude task fails with the CLI's model-unavailability signature,
the failing model is recorded here (settings key ``models:unavailable``), and
the rosters (/api/agents, /api/profiles) hide every profile that runs on it.
Nothing is deleted: the profile stays in the DB, and the entry EXPIRES after a
retry window — if the model is back (resubscribed, restored), the companion
quietly rejoins the crew on its own; if not, the next attempted use re-hides
it. Vanish on hard evidence, return by time — no probes, no spent tokens.
"""

import json
import logging
import re
import time

from .db import db

log = logging.getLogger(__name__)

_KEY = "models:unavailable"
RETRY_SECONDS = 24 * 3600  # how long a model stays vanished before it may retry

# The claude CLI's stable phrasing for a model the account can't use, plus the
# raw API error type for surfaces that pass it through verbatim. Deliberately
# tight: a flaky network or a tool error must never vanish a companion.
_SIGNATURES = (
    re.compile(r"issue with the selected model", re.I),
    re.compile(r"not_found_error[\s\S]{0,120}model|model[\s\S]{0,120}not_found_error", re.I),
)


def is_unavailability_error(error: str) -> bool:
    """Pure: does this failure text say the MODEL itself is unusable?"""
    return bool(error) and any(sig.search(error) for sig in _SIGNATURES)


def prune(entries: dict, now: float) -> dict:
    """Pure: drop entries older than the retry window."""
    return {m: ts for m, ts in entries.items() if isinstance(ts, (int, float)) and now - ts < RETRY_SECONDS}


async def _load() -> dict:
    try:
        row = await db.fetch_one("SELECT value FROM settings WHERE key = ?", (_KEY,))
        return json.loads(row["value"]) if row else {}
    except Exception:  # noqa: BLE001 — a read failure must never break a roster
        return {}


async def _save(entries: dict) -> None:
    await db.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (_KEY, json.dumps(entries)),
    )


async def note_failure(model: str, error: str) -> bool:
    """Record `model` as unavailable when `error` carries the signature.
    Returns True when the model was (re)flagged."""
    model = (model or "").strip()
    if not model or not is_unavailability_error(error):
        return False
    try:
        entries = prune(await _load(), time.time())
        entries[model] = time.time()
        await _save(entries)
        log.warning("model watch: '%s' flagged unavailable — its companions stand down for %dh",
                    model, RETRY_SECONDS // 3600)
        return True
    except Exception:  # noqa: BLE001 — bookkeeping must never break task teardown
        return False


async def unavailable_models() -> set[str]:
    """The models currently standing down (expired entries are dropped lazily)."""
    try:
        entries = await _load()
        live = prune(entries, time.time())
        if live != entries:
            await _save(live)  # persist the expiry so the return is durable
        return set(live)
    except Exception:  # noqa: BLE001
        return set()
