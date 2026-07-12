"""WebSocket endpoint with replay-then-tail subscription protocol.

Client → server messages:
    {"subscribe": ["global", "task:<id>"], "after": {"task:<id>": 412}}
    {"unsubscribe": ["task:<id>"]}

Server → client messages are event dicts with a "channel" field. For task
channels the server first replays persisted rows with seq > after, buffering
live events for that channel during replay so nothing is lost, then tails.
"""

import asyncio
import json
import logging

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect

from .. import ws_tickets
from ..auth import require_token, require_ws_token
from ..db import db, loads_payload
from ..events import bus

log = logging.getLogger(__name__)
router = APIRouter()


@router.post("/api/ws-ticket")
async def issue_ws_ticket(identity: dict = Depends(require_token)) -> dict:
    """Mint a short-lived, single-use ticket for the /ws handshake (finding #3).

    Gated by require_token, so the caller has already proven itself with an
    Authorization: Bearer header. The browser/WebView swaps its long-lived bearer
    for this ticket in the WS query string, so the durable token never rides a URL
    (where it would land in access logs / history). See auth.require_ws_token."""
    return {"ticket": ws_tickets.issue(identity), "expires_in": ws_tickets.TTL_SECONDS}


async def _replay_task_channel(websocket: WebSocket, task_id: str, after_seq: int) -> None:
    rows = await db.fetch_all(
        "SELECT task_id, seq, ts, type, payload FROM task_events"
        " WHERE task_id = ? AND seq > ? ORDER BY seq",
        (task_id, after_seq),
    )
    for row in rows:
        d = loads_payload(row)
        d["channel"] = f"task:{task_id}"
        await websocket.send_text(json.dumps(d))


@router.websocket("/ws")
async def ws_endpoint(websocket: WebSocket) -> None:
    if not await require_ws_token(websocket):
        await websocket.close(code=4401)
        return
    await websocket.accept()

    sub = bus.add_subscriber()

    # One lock serializes EVERY write to this socket. Two coroutines send here — the
    # live-tail sender() and the subscribe handler's replay — and concurrent
    # send_text on a single websocket both corrupts framing and interleaves order (a
    # live seq 14 slipping between replayed 12 and 13). Holding the lock across a
    # channel's whole replay also makes the "buffer live during replay" guarantee
    # real: live events wait in the queue and tail, in seq order, once replay ends.
    send_lock = asyncio.Lock()

    async def _send(obj: dict) -> None:
        async with send_lock:
            await websocket.send_text(json.dumps(obj))

    async def sender() -> None:
        while True:
            message = await sub.queue.get()
            await _send(message)

    send_task = asyncio.create_task(sender())
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            for channel in msg.get("unsubscribe", []):
                sub.channels.discard(channel)

            subscribe = msg.get("subscribe", [])
            after = msg.get("after", {})
            for channel in subscribe:
                if channel.startswith("task:"):
                    # Subscribe first (so live events buffer), then replay the DB
                    # backlog UNDER the send lock so no live event interleaves mid-
                    # replay; the tail resumes in seq order once replay releases it.
                    sub.channels.add(channel)
                    async with send_lock:
                        await _replay_task_channel(websocket, channel[5:], int(after.get(channel, 0)))
                else:
                    sub.channels.add(channel)
            if subscribe:
                await _send({"type": "subscribed", "channels": sorted(sub.channels)})
    except WebSocketDisconnect:
        pass
    finally:
        send_task.cancel()
        bus.remove_subscriber(sub)
