"""Curated import of local Claude memory into Rezident facts (opt-in).

The operator presses SCAN LOCAL ARCHIVES: a cheap persona reads the notebooks
Claude Code already keeps on this machine (~/.claude/CLAUDE.md + per-project
MEMORY.md files) and DISTILLS them into a short list of proposed durable
operator facts. Nothing lands on the board without a checkbox — proposals are
staged in the settings table until the operator applies or dismisses them.

Deliberately NOT an automatic first-run scan: local personas run Claude Code,
which loads ~/.claude/CLAUDE.md natively, so a raw import would double-inject
for them. The distilled, curated form keeps the board short and true; the
main beneficiaries are bridged runtimes (which can't see ~/.claude) and the
operator's own visibility.
"""

import asyncio
import json
import logging
import re
import uuid
from pathlib import Path

from .db import db
from .events import utcnow

log = logging.getLogger(__name__)

STATE_KEY = "memory_import"
MAX_PROPOSALS = 15
MAX_FACT_LEN = 300
MAX_SOURCE_BYTES = 60_000  # digest cap across all archive files

DISTILL_PROMPT = """You are distilling an operator's LOCAL Claude Code memory archives into a short
list of durable facts for Rezident's shared memory board. Do NOT use any tools.
Work only from the archive contents below.

Propose at most {max_n} facts. Each fact must be:
- durable: still true and useful months from now (identity, preferences,
  standing rules, environment facts like key paths or hosts)
- operator-level: about the operator or their world — NOT project-specific
  build instructions, NOT session/task history, NOT code structure
- one concise sentence, under {max_len} characters, self-contained

Skip anything already covered by the CURRENT BOARD FACTS below — no duplicates
or near-duplicates. Skip trivia, dated status notes, and repo-specific
instructions. Fewer good facts beat many weak ones; propose zero if nothing
qualifies.

Reply with one short paragraph of reasoning, then EXACTLY ONE fenced json
block:

```json
{{"facts": ["<fact one>", "<fact two>"]}}
```

--- CURRENT BOARD FACTS ---
{current}

--- LOCAL ARCHIVES ---
{archives}"""


def _read_archives() -> list[dict]:
    """The same surface the Holotapes 'claude files' viewer reads: the global
    CLAUDE.md plus every project's auto-memory index. Read-only, size-capped."""
    home = Path.home() / ".claude"
    out: list[dict] = []
    candidates: list[Path] = [home / "CLAUDE.md"]
    projects = home / "projects"
    if projects.exists():
        for d in sorted(projects.iterdir()):
            candidates.append(d / "memory" / "MEMORY.md")
    budget = MAX_SOURCE_BYTES
    for p in candidates:
        if budget <= 0:
            break
        try:
            if not p.is_file():
                continue
            text = p.read_text(encoding="utf-8", errors="replace")[:20_000]
        except OSError:
            continue
        text = text[:budget]
        budget -= len(text)
        out.append({"name": str(p), "content": text})
    return out


async def _get_state() -> dict:
    row = await db.fetch_one("SELECT value FROM settings WHERE key = ?", (STATE_KEY,))
    if row is None:
        return {"status": "idle", "proposals": [], "task_id": None, "error": None}
    try:
        return json.loads(row["value"])
    except (ValueError, TypeError):
        return {"status": "idle", "proposals": [], "task_id": None, "error": None}


async def _set_state(state: dict) -> None:
    await db.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?)"
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (STATE_KEY, json.dumps(state)),
    )


async def status() -> dict:
    return await _get_state()


async def dismiss() -> dict:
    state = {"status": "idle", "proposals": [], "task_id": None, "error": None}
    await _set_state(state)
    return state


async def start_scan() -> dict:
    """Kick off the distillation task. 409-equivalent (ValueError) while one runs."""
    from .task_manager import manager

    state = await _get_state()
    if state.get("status") == "scanning":
        raise ValueError("a scan is already running")

    archives = _read_archives()
    if not archives:
        state = {"status": "failed", "proposals": [], "task_id": None,
                 "error": "no local archives found (~/.claude has no CLAUDE.md or project memory)"}
        await _set_state(state)
        return state

    current = await db.fetch_all(
        "SELECT content FROM memory_facts WHERE enabled = 1 AND agent_key IS NULL"
        " ORDER BY updated_at DESC LIMIT 50"
    )
    prompt = DISTILL_PROMPT.format(
        max_n=MAX_PROPOSALS, max_len=MAX_FACT_LEN,
        current="\n".join(f"- {r['content']}" for r in current) or "(the board is empty)",
        archives="\n\n".join(f"=== {a['name']} ===\n{a['content']}" for a in archives),
    )

    # the cheap courier if it exists, else whatever the default profile is
    profile = await db.fetch_one("SELECT id FROM agent_profiles WHERE id = 'agent-mercury'")
    task = await manager.create_task({
        "title": f"⌬ archive scan · {utcnow()[:10]}",
        "prompt": prompt,
        "kind": "general",
        "profile_id": profile["id"] if profile else None,
        "max_turns": 4,
    })
    state = {"status": "scanning", "proposals": [], "task_id": task["id"], "error": None}
    await _set_state(state)
    asyncio.create_task(_watch(task["id"]), name=f"memimport-{task['id'][:8]}")
    return state


def _parse_facts(raw: str) -> list[str]:
    match = re.search(r"```json\s*(\{.*?\})\s*```", raw or "", re.DOTALL)
    if not match:
        return []
    try:
        parsed = json.loads(match.group(1))
    except json.JSONDecodeError:
        return []
    facts = parsed.get("facts", [])
    if not isinstance(facts, list):
        return []
    out = []
    for f in facts:
        if isinstance(f, str) and f.strip():
            out.append(f.strip()[:MAX_FACT_LEN])
    return out[:MAX_PROPOSALS]


async def _watch(task_id: str) -> None:
    from .task_manager import manager

    try:
        task = None
        for _ in range(150):  # up to ~5 min
            await asyncio.sleep(2)
            task = await manager.get_task(task_id)
            if task and task["status"] in ("done", "failed", "cancelled"):
                break
        ok = task and task["status"] == "done"
        raw = (task.get("result_summary") if task else None) or ""
        proposals = _parse_facts(raw) if ok else []
        if ok:
            state = {"status": "ready", "proposals": proposals, "task_id": task_id, "error": None}
        else:
            err = (task.get("error") if task else None) or "scan task did not finish"
            state = {"status": "failed", "proposals": [], "task_id": task_id, "error": err[:300]}
        await _set_state(state)
    except Exception:  # noqa: BLE001
        log.exception("memory import watcher crashed for %s", task_id)
        await _set_state({"status": "failed", "proposals": [], "task_id": task_id,
                          "error": "scan watcher crashed"})


async def apply(facts: list[str]) -> dict:
    """Save the operator's ticked proposals as global 'imported' facts
    (exact-content dedupe), then mark the staged scan consumed."""
    saved = []
    now = utcnow()
    for content in facts:
        content = (content or "").strip()[:MAX_FACT_LEN]
        if not content:
            continue
        dupe = await db.fetch_one(
            "SELECT id FROM memory_facts WHERE agent_key IS NULL AND content = ?", (content,)
        )
        if dupe:
            continue
        fid = str(uuid.uuid4())
        await db.execute(
            "INSERT INTO memory_facts (id, content, tags, source, agent_key, created_at, updated_at)"
            " VALUES (?, ?, '', 'imported', NULL, ?, ?)",
            (fid, content, now, now),
        )
        saved.append({"id": fid, "content": content})
    await _set_state({"status": "applied", "proposals": [], "task_id": None, "error": None})
    return {"saved": saved, "count": len(saved)}
