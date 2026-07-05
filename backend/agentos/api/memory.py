import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import require_token
from ..db import db
from ..events import utcnow

router = APIRouter(prefix="/api/memory", dependencies=[Depends(require_token)])


class FactCreate(BaseModel):
    content: str = Field(min_length=1, max_length=2000)
    tags: str = ""


class FactPatch(BaseModel):
    content: str | None = None
    tags: str | None = None
    enabled: bool | None = None


@router.get("/facts")
async def list_facts(q: str | None = None) -> list[dict]:
    if q:
        rows = await db.fetch_all(
            "SELECT * FROM memory_facts WHERE content LIKE ? OR tags LIKE ? ORDER BY updated_at DESC",
            (f"%{q}%", f"%{q}%"),
        )
    else:
        rows = await db.fetch_all("SELECT * FROM memory_facts ORDER BY updated_at DESC")
    return [dict(r) for r in rows]


@router.post("/facts", status_code=201)
async def create_fact(body: FactCreate) -> dict:
    fact_id = str(uuid.uuid4())
    now = utcnow()
    await db.execute(
        "INSERT INTO memory_facts (id, content, tags, source, created_at, updated_at) VALUES (?, ?, ?, 'user', ?, ?)",
        (fact_id, body.content, body.tags, now, now),
    )
    return dict(await db.fetch_one("SELECT * FROM memory_facts WHERE id = ?", (fact_id,)))


@router.patch("/facts/{fact_id}")
async def patch_fact(fact_id: str, body: FactPatch) -> dict:
    sets, params = ["updated_at = ?"], [utcnow()]
    for key, value in body.model_dump(exclude_none=True).items():
        sets.append(f"{key} = ?")
        params.append(int(value) if isinstance(value, bool) else value)
    params.append(fact_id)
    await db.execute(f"UPDATE memory_facts SET {', '.join(sets)} WHERE id = ?", tuple(params))
    row = await db.fetch_one("SELECT * FROM memory_facts WHERE id = ?", (fact_id,))
    if row is None:
        raise HTTPException(404, "fact not found")
    return dict(row)


@router.delete("/facts/{fact_id}")
async def delete_fact(fact_id: str) -> dict:
    await db.execute("DELETE FROM memory_facts WHERE id = ?", (fact_id,))
    return {"ok": True}


@router.get("/episodes")
async def list_episodes(q: str | None = None, limit: int = 100) -> list[dict]:
    if q:
        rows = await db.fetch_all(
            "SELECT * FROM episodes WHERE title LIKE ? OR summary LIKE ? ORDER BY created_at DESC LIMIT ?",
            (f"%{q}%", f"%{q}%", limit),
        )
    else:
        rows = await db.fetch_all("SELECT * FROM episodes ORDER BY created_at DESC LIMIT ?", (limit,))
    return [dict(r) for r in rows]


@router.get("/claude-files")
async def claude_memory_files() -> list[dict]:
    """Read-only listing of ~/.claude memory-ish files (CLAUDE.md etc.)."""
    home = Path.home() / ".claude"
    out = []
    for name in ("CLAUDE.md",):
        p = home / name
        if p.exists():
            out.append({"name": str(p), "content": p.read_text(encoding="utf-8", errors="replace")[:20000]})
    projects = home / "projects"
    if projects.exists():
        for d in sorted(projects.iterdir()):
            mem = d / "memory" / "MEMORY.md"
            if mem.exists():
                out.append({"name": str(mem), "content": mem.read_text(encoding="utf-8", errors="replace")[:20000]})
    return out
