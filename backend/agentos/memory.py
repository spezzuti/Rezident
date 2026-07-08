"""AgentOS memory: durable facts injected into every agent's system prompt,
plus an episode log of completed tasks (what ran, outcome, cost).

v2 (docs/agent-memory.md): facts can belong to one agent identity
(memory_facts.agent_key — 'profile:<id>' / 'integration:<key>' / NULL=global),
and agents write their own facts in-band via a fenced ```agentos-memory block.
The text protocol needs no tools or token, so it works identically for local
Claude personas and remote runtimes like redacted.
"""

import json
import re
import uuid

from .db import db
from .events import utcnow

MAX_INJECTED_FACTS = 50
MAX_AGENT_FACTS = 30
MAX_REMEMBER_PER_MESSAGE = 5
MAX_FACT_LEN = 500

_WRITEBACK_RE = re.compile(r"```agentos-memory\s*(\{.*?\})\s*```", re.DOTALL)

WRITEBACK_PROTOCOL = """
## Remembering (write-back protocol)
To remember something durable — a correction, a stated preference, a fact that
will matter next session — end a reply with:

```agentos-memory
{"remember": ["<one concise fact>"], "forget": ["<exact text of one of your facts>"]}
```

Durable facts only; never session trivia or things the operator can see
themselves. Before finishing a task, consider whether anything durable was
learned. The block is stripped from your reply before display.
"""


async def render_block(agent_key: str | None = None) -> str:
    """Memory as a system-prompt append: operator facts (global), plus — when an
    agent identity is given — that agent's own facts and the write-back protocol.
    Empty string when there is nothing to say and no identity to teach."""
    rows = await db.fetch_all(
        "SELECT content FROM memory_facts WHERE enabled = 1 AND agent_key IS NULL"
        " ORDER BY updated_at DESC LIMIT ?",
        (MAX_INJECTED_FACTS,),
    )
    parts: list[str] = []
    if rows:
        lines = "\n".join(f"- {r['content']}" for r in rows)
        parts.append(
            "\n\n# Operator memory (AgentOS)\n"
            "Durable facts your operator has saved. Trust them unless the task says otherwise:\n"
            f"{lines}\n"
        )
    if agent_key:
        own = await db.fetch_all(
            "SELECT content FROM memory_facts WHERE enabled = 1 AND agent_key = ?"
            " ORDER BY updated_at DESC LIMIT ?",
            (agent_key, MAX_AGENT_FACTS),
        )
        if own:
            lines = "\n".join(f"- {r['content']}" for r in own)
            parts.append(
                "\n# Your memory\n"
                "Notes you saved in earlier sessions:\n"
                f"{lines}\n"
            )
        parts.append(WRITEBACK_PROTOCOL)
    return "".join(parts)


def extract_writeback(text: str) -> tuple[str, list[str], list[str]]:
    """Split a trailing ```agentos-memory block out of a reply.
    Returns (clean_text, remember[], forget[]). Malformed JSON → the block is
    still stripped (never shown) but yields no directives."""
    match = _WRITEBACK_RE.search(text or "")
    if not match:
        return text, [], []
    clean = (text[: match.start()] + text[match.end():]).strip()
    try:
        parsed = json.loads(match.group(1))
    except json.JSONDecodeError:
        return clean, [], []
    remember = [s.strip()[:MAX_FACT_LEN] for s in parsed.get("remember", []) if isinstance(s, str) and s.strip()]
    forget = [s.strip() for s in parsed.get("forget", []) if isinstance(s, str) and s.strip()]
    return clean, remember[:MAX_REMEMBER_PER_MESSAGE], forget


async def apply_writeback(agent_key: str, remember: list[str], forget: list[str]) -> dict:
    """Persist an agent's memory directives. Remembers dedupe on exact content
    for the same agent; forgets disable (never delete) the agent's OWN facts by
    exact content, so the operator can review and re-enable."""
    saved: list[dict] = []
    now = utcnow()
    for content in remember:
        dupe = await db.fetch_one(
            "SELECT id FROM memory_facts WHERE agent_key = ? AND content = ?", (agent_key, content)
        )
        if dupe:
            continue
        fact_id = str(uuid.uuid4())
        await db.execute(
            "INSERT INTO memory_facts (id, content, tags, source, agent_key, created_at, updated_at)"
            " VALUES (?, ?, '', 'agent', ?, ?, ?)",
            (fact_id, content, agent_key, now, now),
        )
        saved.append({"id": fact_id, "content": content})
    forgotten: list[str] = []
    for content in forget:
        row = await db.fetch_one(
            "SELECT id FROM memory_facts WHERE agent_key = ? AND content = ? AND enabled = 1",
            (agent_key, content),
        )
        if row:
            await db.execute(
                "UPDATE memory_facts SET enabled = 0, updated_at = ? WHERE id = ?", (now, row["id"])
            )
            forgotten.append(content)
    return {"agent_key": agent_key, "remember": saved, "forget": forgotten}


async def handle_reply(task_id: str, agent_key: str | None, text: str) -> str:
    """One-stop hook for every reply path: strip the write-back block, apply the
    directives, emit a memory_write task event. Returns the cleaned text."""
    from .events import bus

    clean, remember, forget = extract_writeback(text)
    if agent_key and (remember or forget):
        result = await apply_writeback(agent_key, remember, forget)
        if result["remember"] or result["forget"]:
            await bus.emit_task_event(task_id, "memory_write", result)
    return clean


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
