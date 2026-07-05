"""AgentOS memory: durable facts injected into every agent's system prompt,
plus an episode log of completed tasks (what ran, outcome, cost).
"""

import uuid

from .db import db
from .events import utcnow

MAX_INJECTED_FACTS = 50


async def render_block() -> str:
    """Enabled facts as a system-prompt append. Empty string when none."""
    rows = await db.fetch_all(
        "SELECT content FROM memory_facts WHERE enabled = 1 ORDER BY updated_at DESC LIMIT ?",
        (MAX_INJECTED_FACTS,),
    )
    if not rows:
        return ""
    lines = "\n".join(f"- {r['content']}" for r in rows)
    return (
        "\n\n# Operator memory (AgentOS)\n"
        "Durable facts your operator has saved. Trust them unless the task says otherwise:\n"
        f"{lines}\n"
    )


async def add_episode(task: dict) -> None:
    await db.execute(
        "INSERT INTO episodes (id, task_id, title, summary, outcome, cost_usd, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            str(uuid.uuid4()),
            task["id"],
            task["title"],
            (task.get("result_summary") or task.get("error") or "")[:1000],
            task["status"],
            task.get("total_cost_usd") or 0,
            utcnow(),
        ),
    )
