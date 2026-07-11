from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import knowledge
from ..auth import require_master, require_token

# Read routes stay require_token (the phone can browse KBs + status); create /
# delete / index / config-write are master-only. This router is registered in
# main.py by a later chunk — nothing here mounts it.
router = APIRouter(prefix="/api/knowledge", dependencies=[Depends(require_token)])


class KBCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    source_dir: str = Field(min_length=1)
    description: str | None = None


class KBConfigBody(BaseModel):
    provider_key: str | None = None
    model: str | None = None
    top_k: int | None = None


@router.get("")
async def list_knowledge() -> list[dict]:
    return await knowledge.list_bases()


@router.post("", status_code=201, dependencies=[Depends(require_master)])
async def create_knowledge(body: KBCreate) -> dict:
    return await knowledge.create_base(body.name, body.source_dir, body.description)


# Static /config routes are declared before the /{kb_id} ones so a literal
# "config" segment can never be captured as a kb_id.
@router.get("/config")
async def get_knowledge_config() -> dict:
    return await knowledge.get_config()


@router.put("/config", dependencies=[Depends(require_master)])
async def put_knowledge_config(body: KBConfigBody) -> dict:
    return await knowledge.set_config(
        provider_key=body.provider_key, model=body.model, top_k=body.top_k
    )


@router.get("/{kb_id}/status")
async def knowledge_status(kb_id: str) -> dict:
    base = await knowledge.status(kb_id)
    if base is None:
        raise HTTPException(404, "knowledge base not found")
    return base


@router.post("/{kb_id}/index", status_code=202, dependencies=[Depends(require_master)])
async def index_knowledge(kb_id: str) -> dict:
    try:
        return await knowledge.start_index(kb_id)
    except KeyError:
        raise HTTPException(404, "knowledge base not found")
    except ValueError as exc:
        raise HTTPException(409, str(exc))


@router.delete("/{kb_id}", dependencies=[Depends(require_master)])
async def delete_knowledge(kb_id: str) -> dict:
    if not await knowledge.delete_base(kb_id):
        raise HTTPException(404, "knowledge base not found")
    return {"ok": True}
