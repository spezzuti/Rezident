from fastapi import APIRouter, Depends

from ..auth import require_token
from ..db import db
from ..dreams import start_dream

router = APIRouter(prefix="/api/dreams", dependencies=[Depends(require_token)])


@router.get("")
async def list_dreams(limit: int = 30) -> list[dict]:
    rows = await db.fetch_all("SELECT * FROM dreams ORDER BY created_at DESC LIMIT ?", (limit,))
    return [dict(r) for r in rows]


@router.post("/run", status_code=201)
async def run_dream() -> dict:
    return await start_dream()
