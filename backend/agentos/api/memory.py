import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import require_master, require_token
from ..db import db
from ..events import utcnow

# Read routes stay require_token so the phone can browse memory; fact writes and
# the archive-import actions are master-only.
router = APIRouter(prefix="/api/memory", dependencies=[Depends(require_token)])


class FactCreate(BaseModel):
    content: str = Field(min_length=1, max_length=2000)
    tags: str = ""
    # 'profile:<id>' / 'integration:<key>' to hand a fact to one agent; None = global
    agent_key: str | None = None


class FactPatch(BaseModel):
    content: str | None = None
    tags: str | None = None
    enabled: bool | None = None


@router.get("/facts")
async def list_facts(q: str | None = None, agent_key: str | None = None) -> list[dict]:
    where, params = [], []
    if q:
        where.append("(content LIKE ? OR tags LIKE ?)")
        params += [f"%{q}%", f"%{q}%"]
    if agent_key:
        where.append("agent_key = ?")
        params.append(agent_key)
    sql = "SELECT * FROM memory_facts"
    if where:
        sql += " WHERE " + " AND ".join(where)
    rows = await db.fetch_all(sql + " ORDER BY updated_at DESC", tuple(params))
    return [dict(r) for r in rows]


@router.post("/facts", status_code=201, dependencies=[Depends(require_master)])
async def create_fact(body: FactCreate) -> dict:
    fact_id = str(uuid.uuid4())
    now = utcnow()
    await db.execute(
        "INSERT INTO memory_facts (id, content, tags, source, agent_key, created_at, updated_at)"
        " VALUES (?, ?, ?, 'user', ?, ?, ?)",
        (fact_id, body.content, body.tags, body.agent_key, now, now),
    )
    return dict(await db.fetch_one("SELECT * FROM memory_facts WHERE id = ?", (fact_id,)))


@router.patch("/facts/{fact_id}", dependencies=[Depends(require_master)])
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


@router.delete("/facts/{fact_id}", dependencies=[Depends(require_master)])
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


# ---- curated import of local Claude archives (memory_import.py) ----------------


class ImportApply(BaseModel):
    facts: list[str] = Field(min_length=1, max_length=15)


@router.post("/import/scan", status_code=202, dependencies=[Depends(require_master)])
async def import_scan() -> dict:
    from .. import memory_import

    try:
        return await memory_import.start_scan()
    except ValueError as exc:
        raise HTTPException(409, str(exc))


@router.get("/import/status")
async def import_status() -> dict:
    from .. import memory_import

    return await memory_import.status()


@router.post("/import/apply", dependencies=[Depends(require_master)])
async def import_apply(body: ImportApply) -> dict:
    from .. import memory_import

    return await memory_import.apply(body.facts)


@router.post("/import/dismiss", dependencies=[Depends(require_master)])
async def import_dismiss() -> dict:
    from .. import memory_import

    return await memory_import.dismiss()


@router.get("/claude-files", dependencies=[Depends(require_master)])
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
