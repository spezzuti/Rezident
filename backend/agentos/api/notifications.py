from fastapi import APIRouter, Depends
from pydantic import BaseModel

from .. import notify
from ..auth import require_token

router = APIRouter(prefix="/api/notifications", dependencies=[Depends(require_token)])


class NotifyBody(BaseModel):
    channel: str = "off"
    ntfy_topic: str = ""
    telegram_token: str | None = None  # blank preserves the stored secret
    telegram_chat: str = ""
    webhook_url: str = ""
    on_approval: bool = True
    on_finish: bool = False


def _strip(cfg: dict) -> dict:
    cfg["has_telegram_token"] = bool(cfg.pop("telegram_token", ""))
    return cfg


@router.get("")
async def get_notifications() -> dict:
    return _strip(await notify.get_config())


@router.put("")
async def put_notifications(body: NotifyBody) -> dict:
    cfg = await notify.save_config(
        channel=body.channel, ntfy_topic=body.ntfy_topic, telegram_token=body.telegram_token,
        telegram_chat=body.telegram_chat, webhook_url=body.webhook_url,
        on_approval=body.on_approval, on_finish=body.on_finish,
    )
    return _strip(cfg)


@router.post("/test")
async def test_notifications() -> dict:
    return await notify.send_test()
