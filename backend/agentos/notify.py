"""Away-notifications — push to the operator's phone when a task needs them and
the dashboard isn't open in front of them.

In-app signals (browser Notification, sound, tab badge) are handled client-side;
this module is the SERVER-side leg: it fires an external push over one of three
zero-infra channels the moment a task hits an approval gate (or finishes, if the
user opts in), so a walked-away operator gets pinged even with no tab open.

Channels (pick one in Settings > Notifications):
  * ntfy     -> POST https://ntfy.sh/<topic>  (install the ntfy app, subscribe to
                the topic; no account, no key)
  * telegram -> POST api.telegram.org/bot<token>/sendMessage  (a bot + chat id)
  * webhook  -> POST <url> {title, body, event, task}  (roll your own / Slack / …)

Every send is fire-and-forget and fully guarded: a slow or broken push never
stalls or fails the task it's reporting on.
"""

import asyncio
import json

import httpx

from .db import db

_KEY = "notify:config"

_DEFAULT = {
    "channel": "off",          # off | ntfy | telegram | webhook
    "ntfy_topic": "",          # bare topic ("agentos-alerts") or a full https URL
    "telegram_token": "",      # bot token from @BotFather  (write-only in the API)
    "telegram_chat": "",       # chat id to send to
    "webhook_url": "",         # any endpoint that accepts a JSON POST
    "on_approval": True,       # ping when a task needs an approval decision
    "on_finish": False,        # ping when a task finishes (done/failed)
}


async def get_config() -> dict:
    """Full stored config INCLUDING the telegram token (internal use)."""
    row = await db.fetch_one("SELECT value FROM settings WHERE key = ?", (_KEY,))
    cfg = dict(_DEFAULT)
    if row:
        try:
            cfg.update(json.loads(row["value"]))
        except (TypeError, json.JSONDecodeError):
            pass
    return cfg


async def save_config(*, channel: str, ntfy_topic: str, telegram_token: str | None,
                      telegram_chat: str, webhook_url: str, on_approval: bool, on_finish: bool) -> dict:
    """Persist config. A blank/None telegram_token PRESERVES the stored one, so a
    plain toggle never wipes the bot secret (same rule as integration tokens)."""
    cfg = await get_config()
    cfg["channel"] = (channel or "off").strip()
    cfg["ntfy_topic"] = (ntfy_topic or "").strip()
    cfg["telegram_chat"] = (telegram_chat or "").strip()
    cfg["webhook_url"] = (webhook_url or "").strip()
    cfg["on_approval"] = bool(on_approval)
    cfg["on_finish"] = bool(on_finish)
    if telegram_token:  # only overwrite when a new secret is actually supplied
        cfg["telegram_token"] = telegram_token
    await db.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (_KEY, json.dumps(cfg)),
    )
    return cfg


def _ntfy_url(topic: str) -> str:
    topic = topic.strip()
    if topic.startswith("http://") or topic.startswith("https://"):
        return topic
    return "https://ntfy.sh/" + topic.lstrip("/")


async def _send(cfg: dict, title: str, body: str, *, priority: str = "default", tags: str = "robot") -> tuple[bool, str]:
    """Deliver one message over the configured channel. Returns (ok, detail)."""
    channel = (cfg.get("channel") or "off").strip()
    if channel == "off":
        return False, "notifications are off"
    try:
        async with httpx.AsyncClient(timeout=12.0, follow_redirects=True) as client:
            if channel == "ntfy":
                topic = cfg.get("ntfy_topic") or ""
                if not topic.strip():
                    return False, "no ntfy topic set"
                resp = await client.post(
                    _ntfy_url(topic), content=body.encode("utf-8"),
                    headers={"Title": title, "Priority": priority, "Tags": tags},
                )
            elif channel == "telegram":
                token = (cfg.get("telegram_token") or "").strip()
                chat = (cfg.get("telegram_chat") or "").strip()
                if not token or not chat:
                    return False, "telegram needs a bot token AND a chat id"
                resp = await client.post(
                    f"https://api.telegram.org/bot{token}/sendMessage",
                    json={"chat_id": chat, "text": f"{title}\n{body}"},
                )
            elif channel == "webhook":
                url = (cfg.get("webhook_url") or "").strip()
                if not url:
                    return False, "no webhook URL set"
                resp = await client.post(url, json={"title": title, "body": body, "priority": priority})
            else:
                return False, f"unknown channel '{channel}'"
    except httpx.HTTPError as exc:
        return False, f"{type(exc).__name__}: {str(exc)[:140]}"
    if resp.status_code >= 400:
        return False, f"HTTP {resp.status_code}: {resp.text[:160]}"
    return True, f"sent via {channel} (HTTP {resp.status_code})"


async def send_test() -> dict:
    cfg = await get_config()
    ok, detail = await _send(cfg, "Rezident test", "If you can read this, away-notifications are wired up.", tags="white_check_mark")
    return {"ok": ok, "detail": detail}


async def _notify(kind: str, title: str, detail: str) -> None:
    """Config-gated single notification. Fully guarded — never raises."""
    try:
        cfg = await get_config()
        if (cfg.get("channel") or "off") == "off":
            return
        if kind == "approval" and not cfg.get("on_approval", True):
            return
        if kind == "finish" and not cfg.get("on_finish", False):
            return
        if kind == "pipeline" and not cfg.get("on_finish", False):
            return
        if kind == "approval":
            await _send(cfg, "⏸ Approval needed", f"{title}\nwants to run: {detail}", priority="high", tags="warning")
        elif kind == "finish":
            emoji = "✅" if detail == "done" else "❌"
            await _send(cfg, f"{emoji} Task {detail}", title, priority="default", tags="robot")
        elif kind == "pipeline":
            emoji = "🛰" if detail == "done" else "⚠"
            await _send(cfg, f"{emoji} Operation {detail}", title, priority="default", tags="satellite")
    except Exception:  # a notification must never break the task it's reporting on
        pass


def fire(kind: str, title: str, detail: str = "") -> None:
    """Fire-and-forget from a running event loop — schedule the push and return."""
    try:
        asyncio.get_running_loop().create_task(_notify(kind, title, detail))
    except RuntimeError:
        pass  # no loop (shouldn't happen from the async runner) — just skip
