"""Dreaming: the OS reflects on its own history during idle time.

A dream spawns a read-only agent (Athena if she exists) over a digest of
recent episodes, memory facts, costs, rule hits, and schedules, and asks for
observations + concrete suggestions: what to automate, which agents or rules
to add, what to build next. Results land in the dreams table and the
Dreaming view. Hermes calls this "dreaming"; the OS improves itself.
"""

import asyncio
import json
import logging
import uuid

from .db import db
from .events import bus, utcnow

log = logging.getLogger(__name__)

DREAM_PROMPT = """You are the dreaming subsystem of Rezident — a self-hosted agentic operating system.
While the operator is away, you reflect on the OS's recent activity and produce insight.
Do NOT use any tools. Work only from the system digest below.

Respond in exactly this markdown structure:

## Observations
3-6 bullet points: patterns in what the operator runs, failure patterns, cost patterns, memory gaps.

## Suggestions
3-5 numbered, concrete, immediately-actionable suggestions. Each one of:
- a schedule worth creating (give the cron + the prompt),
- an approval rule worth adding (give tool + pattern + allow/deny),
- a Pantheon agent worth summoning (name, model tier, role),
- a pipeline worth building (stages),
- or a memory fact worth saving (exact wording).

## Next Build
One paragraph: the single most valuable thing to build or automate next, and why.

Then, at the very end, emit your suggestions again as machine-readable actions in ONE fenced json block:

```json
{{"actions": [
  {{"type": "schedule", "name": "...", "cron": "0 9 * * *", "prompt": "..."}},
  {{"type": "rule", "tool": "Bash", "field": "command", "match_type": "prefix", "pattern": "...", "action": "allow"}},
  {{"type": "agent", "name": "...", "model": "haiku|sonnet|opus", "role": "...", "persona": "..."}},
  {{"type": "fact", "content": "..."}},
  {{"type": "pipeline", "name": "...", "stages": [{{"name": "...", "prompt": "..."}}]}}
]}}
```
Only include action types from that list, only for suggestions you actually made.

--- SYSTEM DIGEST ---
{digest}"""


def _extract_actions(raw: str) -> tuple[str, list[dict]]:
    """Split the trailing ```json actions block out of the dream prose."""
    import re

    match = re.search(r"```json\s*(\{.*?\})\s*```", raw, re.DOTALL)
    if not match:
        return raw, []
    try:
        parsed = json.loads(match.group(1))
        actions = parsed.get("actions", [])
        if not isinstance(actions, list):
            actions = []
    except json.JSONDecodeError:
        return raw, []
    content = (raw[: match.start()] + raw[match.end():]).strip()
    return content, actions


async def _build_digest() -> str:
    episodes = await db.fetch_all(
        "SELECT title, outcome, cost_usd, summary, created_at FROM episodes ORDER BY created_at DESC LIMIT 25"
    )
    facts = await db.fetch_all(
        "SELECT content, enabled, agent_key FROM memory_facts ORDER BY updated_at DESC LIMIT 30"
    )
    rules = await db.fetch_all(
        "SELECT tool_name, pattern, action, hit_count FROM auto_approve_rules WHERE hit_count > 0 ORDER BY hit_count DESC LIMIT 10"
    )
    schedules = await db.fetch_all("SELECT name, cron_expr, enabled FROM schedules")
    stats = await db.fetch_one(
        "SELECT COUNT(*) AS n, COALESCE(SUM(total_cost_usd),0) AS cost,"
        " SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed FROM tasks WHERE created_at >= date('now','-7 days')"
    )
    approvals = await db.fetch_all(
        "SELECT tool_name, status, COUNT(*) AS n FROM approvals GROUP BY tool_name, status ORDER BY n DESC LIMIT 12"
    )
    # agent homes (docs/agent-homes.md): what each persona is keeping — lets a
    # dream notice abandoned work, propose cleanups, or flag over-budget homes
    from .homes import home_stats, list_home

    profiles = await db.fetch_all("SELECT id, name FROM agent_profiles ORDER BY created_at")
    home_lines = []
    for p in profiles:
        st = home_stats(p["id"])
        if not st["files"]:
            continue
        newest = ", ".join(f["path"] for f in list_home(p["id"])["files"][:3])
        flag = " · OVER BUDGET" if st["over_budget"] else ""
        home_lines.append(
            f"- {p['name']}: {st['files']} files · {st['bytes'] // 1024}KB{flag} · newest: {newest}"
        )

    parts = [
        f"Last 7 days: {stats['n']} tasks, {stats['failed'] or 0} failed, ~${stats['cost']:.2f} spent.",
        "\nRecent episodes (newest first):",
        *(f"- [{e['outcome']}] {e['title']} (~${e['cost_usd']:.2f}): {(e['summary'] or '')[:150]}" for e in episodes),
        "\nMemory facts:",
        *(
            f"- [{'on' if f['enabled'] else 'off'}]"
            f"{' [' + f['agent_key'] + ']' if f['agent_key'] else ''} {f['content'][:150]}"
            for f in facts
        ),
        "\nMost-hit approval rules:",
        *(f"- {r['action']} {r['tool_name']} /{r['pattern'][:60]}/ ({r['hit_count']} hits)" for r in rules),
        "\nApproval decisions by tool:",
        *(f"- {a['tool_name']}: {a['status']} ×{a['n']}" for a in approvals),
        "\nSchedules:",
        *(f"- [{'on' if s['enabled'] else 'off'}] {s['name']} ({s['cron_expr']})" for s in schedules),
        "\nAgent home directories (persistent workspaces):",
        *(home_lines or ["- all empty — no persona has kept working files yet"]),
    ]
    return "\n".join(parts)


async def start_dream(scheduled_for: str | None = None, schedule_id: str | None = None) -> dict | None:
    """Kick off a dream. When fired by the scheduler, (schedule_id, scheduled_for)
    carry the cron occurrence being consumed so create_task can dedupe a crash-replay
    on the partial unique index; it returns None if this occurrence already fired (no
    second, PAID dream). BOTH are needed — the index only covers rows where both are
    non-NULL. Manual/API callers pass neither, never conflict, and always get the
    {dream_id, task_id} dict."""
    from .task_manager import manager

    dream_id = str(uuid.uuid4())
    digest = await _build_digest()

    profile = await db.fetch_one("SELECT id FROM agent_profiles WHERE id = 'agent-athena'")
    task = await manager.create_task({
        "title": f"☾ dream · {utcnow()[:10]}",
        "prompt": DREAM_PROMPT.format(digest=digest),
        "kind": "general",
        "profile_id": profile["id"] if profile else None,
        "max_turns": 4,
        "schedule_id": schedule_id,
        "scheduled_for": scheduled_for,
    })
    if task is None:
        return None  # this scheduled occurrence already fired (crash replay) — no duplicate dream
    await db.execute(
        "INSERT INTO dreams (id, status, task_id, created_at) VALUES (?, 'dreaming', ?, ?)",
        (dream_id, task["id"], utcnow()),
    )
    asyncio.create_task(_watch(dream_id, task["id"]), name=f"dream-{dream_id[:8]}")
    bus.publish_global("dream_update", {"id": dream_id, "status": "dreaming"})
    return {"dream_id": dream_id, "task_id": task["id"]}


async def _watch(dream_id: str, task_id: str) -> None:
    from .task_manager import manager

    try:
        for _ in range(300):  # up to ~10 min
            await asyncio.sleep(2)
            task = await manager.get_task(task_id)
            if task and task["status"] in ("done", "failed", "cancelled"):
                break
        else:
            task = await manager.get_task(task_id)
        ok = task and task["status"] == "done" and task.get("result_summary")
        raw = (task.get("result_summary") if task else None) or (task.get("error") if task else "no result")
        content, actions = _extract_actions(raw or "")
        await db.execute(
            "UPDATE dreams SET status = ?, content = ?, actions = ?, cost_usd = ?, finished_at = ? WHERE id = ?",
            (
                "complete" if ok else "failed",
                content,
                json.dumps(actions),
                (task.get("total_cost_usd") if task else 0) or 0,
                utcnow(),
                dream_id,
            ),
        )
    except Exception:  # noqa: BLE001
        log.exception("dream %s watcher crashed", dream_id)
        await db.execute(
            "UPDATE dreams SET status='failed', content='watcher crashed', finished_at=? WHERE id=?",
            (utcnow(), dream_id),
        )
    bus.publish_global("dream_update", {"id": dream_id, "status": "complete"})
