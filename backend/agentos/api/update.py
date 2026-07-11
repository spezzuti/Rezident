"""Self-update REST surface. Every route is MASTER-token-only (self-update /
restart is a host-level action a scoped device token must never reach); the UIs
poll /status, force a check, and drive snooze/skip/settings/apply from it. No
route ever leaks a dead end — /status always carries a release_url even on error."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..auth import require_master
from .. import update

router = APIRouter(dependencies=[Depends(require_master)])


class AutoCheckBody(BaseModel):
    auto_check: bool


@router.get("/api/update/status")
async def update_status() -> dict:
    return await update.status()


@router.post("/api/update/check")
async def update_check() -> dict:
    """Force a fresh depot poll, bypassing the 6h cache."""
    return await update.status(force=True)


@router.post("/api/update/snooze")
async def update_snooze() -> dict:
    """NOT NOW — suppress prompts for 24h (the user's one hard requirement)."""
    return await update.snooze()


@router.post("/api/update/skip")
async def update_skip() -> dict:
    return await update.skip()


@router.post("/api/update/unskip")
async def update_unskip() -> dict:
    """RECONSIDER — clear a skipped build so it's offered again (no dead-end skip)."""
    return await update.unskip()


@router.post("/api/update/unsnooze")
async def update_unsnooze() -> dict:
    """SHOW NOW — drop the snooze deadline so the prompt resurfaces immediately."""
    return await update.unsnooze()


@router.post("/api/update/settings")
async def update_settings(body: AutoCheckBody) -> dict:
    return await update.set_auto_check(body.auto_check)


@router.post("/api/update/apply")
async def update_apply() -> dict:
    return await update.start_apply()


@router.get("/api/update/apply")
async def update_apply_status() -> dict:
    return update.job_status()
