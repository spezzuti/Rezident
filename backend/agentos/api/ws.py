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

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..auth import require_ws_token
from ..db import db, loads_payload
from ..events import bus

log = logging.getLogger(__name__)
router = APIRouter()


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

    async def sender() -> None:
        while True:
            message = await sub.queue.get()
            await websocket.send_text(json.dumps(message))

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
                    # Buffer live events during replay by subscribing first;
                    # replay reads the DB which already contains anything
                    # emitted before this moment, and duplicates are filtered
                    # client-side by seq.
                    sub.channels.add(channel)
                    await _replay_task_channel(websocket, channel[5:], int(after.get(channel, 0)))
                else:
                    sub.channels.add(channel)
            if subscribe:
                await websocket.send_text(json.dumps({"type": "subscribed", "channels": sorted(sub.channels)}))
    except WebSocketDisconnect:
        pass
    finally:
        send_task.cancel()
        bus.remove_subscriber(sub)
