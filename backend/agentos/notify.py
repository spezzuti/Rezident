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

Native FCM push (Android companion app) is a SEPARATE, ADDITIVE leg — it fires
ALONGSIDE whichever single channel above is selected (including "off"), so an
operator who lives entirely in the app still gets pinged. See _send_fcm.

Every send is fire-and-forget and fully guarded: a slow or broken push never
stalls or fails the task it's reporting on.
"""

import asyncio
import hashlib
import json
import time

import httpx

from . import devices
from .db import db

_KEY = "notify:config"

# OAuth2 scope for the FCM HTTP v1 API (google-auth mints an access token for it).
_FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"

_DEFAULT = {
    "channel": "off",          # off | ntfy | telegram | webhook
    "ntfy_topic": "",          # bare topic ("agentos-alerts") or a full https URL
    "telegram_token": "",      # bot token from @BotFather  (write-only in the API)
    "telegram_chat": "",       # chat id to send to
    "webhook_url": "",         # any endpoint that accepts a JSON POST
    "on_approval": True,       # ping when a task needs an approval decision
    "on_finish": False,        # ping when a task finishes (done/failed)
    # Native FCM push (fires ALONGSIDE `channel`, independent of it).
    "fcm_project_id": "",      # Firebase project id
    "fcm_service_account": "", # service-account JSON string (write-only in the API)
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
                      telegram_chat: str, webhook_url: str, on_approval: bool, on_finish: bool,
                      fcm_project_id: str = "", fcm_service_account: str | None = None) -> dict:
    """Persist config. A blank/None telegram_token (and fcm_service_account)
    PRESERVES the stored one, so a plain toggle never wipes the secret (same rule
    as integration tokens)."""
    cfg = await get_config()
    cfg["channel"] = (channel or "off").strip()
    cfg["ntfy_topic"] = (ntfy_topic or "").strip()
    cfg["telegram_chat"] = (telegram_chat or "").strip()
    cfg["webhook_url"] = (webhook_url or "").strip()
    cfg["on_approval"] = bool(on_approval)
    cfg["on_finish"] = bool(on_finish)
    cfg["fcm_project_id"] = (fcm_project_id or "").strip()
    if telegram_token:  # only overwrite when a new secret is actually supplied
        cfg["telegram_token"] = telegram_token
    if fcm_service_account:  # blank preserves the stored service-account JSON
        cfg["fcm_service_account"] = fcm_service_account
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


# ---- Native FCM push (Android companion) --------------------------------------
# Additive fan-out to every paired device that has registered an FCM token. This
# is INDEPENDENT of the mutually-exclusive `channel` setting: it fires alongside
# whatever channel is selected (even "off"), because the operator may rely solely
# on the app. All sends are fully guarded — an FCM failure never touches the task.
#
# ─── FCM `data` payload contract (C6's FirebaseMessagingService depends on this) ──
# Every push carries a `data` block whose values are ALL strings (FCM requires it).
# Keys (present "as available"):
#   type        always — the notification kind: "approval" | "finish" | "pipeline"
#   title       always — human title (the task title for approvals/finish)
#   body        always — human one-line body
#   approval_id approvals only — the id C6 posts back to approve/deny
#   task_id     approvals only — the owning task id
#   tool        approvals only — the tool the agent wants to run
#   command     approvals only, when available — the concrete command/args
# C6 builds the notification + inline Approve/Deny buttons FROM this data block
# (a data-message is the reliable path for action buttons); an optional
# `notification` block is included too, purely for lockscreen display.

# Cached OAuth2 access token so we don't mint one on every push. Keyed by a hash
# of the service-account JSON so rotating creds transparently invalidates it.
_fcm_token_cache: dict = {"key": None, "token": None, "exp": 0.0}


async def _fcm_access_token(sa_json: str) -> str | None:
    """Mint (or reuse a cached) OAuth2 access token for the FCM v1 API. google-auth
    is synchronous, so the refresh runs in a worker thread to spare the event loop.
    Returns None if the service-account JSON is unusable."""
    key = hashlib.sha256(sa_json.encode("utf-8")).hexdigest()
    now = time.time()
    cached = _fcm_token_cache
    if cached["token"] and cached["key"] == key and now < cached["exp"] - 60:
        return cached["token"]

    def _mint() -> tuple[str, float]:
        from datetime import timezone

        from google.auth.transport.requests import Request
        from google.oauth2 import service_account

        info = json.loads(sa_json)
        creds = service_account.Credentials.from_service_account_info(info, scopes=[_FCM_SCOPE])
        creds.refresh(Request())
        exp = creds.expiry  # naive UTC datetime, or None
        exp_epoch = exp.replace(tzinfo=timezone.utc).timestamp() if exp else now + 3300
        return creds.token, exp_epoch

    token, exp_epoch = await asyncio.to_thread(_mint)
    _fcm_token_cache.update(key=key, token=token, exp=exp_epoch)
    return token


def _fcm_token_is_dead(resp: httpx.Response) -> bool:
    """True when an FCM response says the target token is gone/invalid and should
    be pruned: HTTP 404, or an error status/errorCode of UNREGISTERED/INVALID_ARGUMENT."""
    if resp.status_code == 404:
        return True
    if resp.status_code < 400:
        return False
    try:
        err = resp.json().get("error", {}) or {}
    except (ValueError, AttributeError):
        return False
    codes = {err.get("status") or ""}
    for det in err.get("details", []) or []:
        ec = det.get("errorCode")
        if ec:
            codes.add(ec)
    return bool(codes & {"UNREGISTERED", "INVALID_ARGUMENT", "NOT_FOUND"})


async def _send_fcm(cfg: dict, *, title: str, body: str, data: dict) -> None:
    """Fan a push out to every device with a registered FCM token. No-op unless a
    project id + service account are configured AND at least one device has a token.
    Fully guarded — never raises into the caller (fire-and-forget guarantee)."""
    project_id = (cfg.get("fcm_project_id") or "").strip()
    sa_json = (cfg.get("fcm_service_account") or "").strip()
    if not project_id or not sa_json:
        return
    try:
        targets = [
            d for d in await devices.list_devices()
            if (d.get("fcm_token") or "").strip() and not d.get("revoked")
        ]
        if not targets:
            return
        token = await _fcm_access_token(sa_json)
        if not token:
            return
        # FCM `data` values MUST be strings; drop keys that resolved to None.
        data_block = {k: str(v) for k, v in data.items() if v is not None}
        url = f"https://fcm.googleapis.com/v1/projects/{project_id}/messages:send"
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        async with httpx.AsyncClient(timeout=12.0) as client:
            for d in targets:
                # DATA-ONLY on purpose — no `notification` block. A message that carries
                # a `notification` block is auto-displayed by the FCM SDK when the app is
                # backgrounded and onMessageReceived is NEVER called, so the native
                # service can't attach the inline Approve/Deny actions — the user gets a
                # dead "you have an approval" card with no buttons. Data-only + high
                # priority always wakes onMessageReceived (RezidentMessagingService),
                # which builds the actionable notification from `data` (title/body/tool
                # are already in the data block). Grant the app unrestricted battery so
                # Doze doesn't defer these.
                message = {
                    "token": d["fcm_token"],
                    "android": {"priority": "high"},
                    "data": data_block,
                }
                try:
                    resp = await client.post(url, headers=headers, json={"message": message})
                except httpx.HTTPError:
                    continue  # transient network error — leave the token in place
                if _fcm_token_is_dead(resp):
                    try:
                        await devices.set_fcm_token(d["id"], None)  # prune the dead token
                    except Exception:
                        pass
    except Exception:  # a push must never break the task it's reporting on
        pass


async def _notify(kind: str, title: str, detail: str, data: dict | None = None) -> None:
    """Config-gated notification. Runs kind-gating FIRST, then fans out over BOTH
    the single configured `channel` (when not "off") AND native FCM (when
    configured) — each guarded independently so one failing never blocks the other.
    Fully guarded — never raises."""
    try:
        cfg = await get_config()
        # Kind-gating runs FIRST so it applies to every leg (channel AND FCM).
        if kind == "approval" and not cfg.get("on_approval", True):
            return
        if kind in ("finish", "pipeline") and not cfg.get("on_finish", False):
            return

        # Compose the human-facing message + the FCM data block for this kind.
        fcm_data: dict = {"type": kind, "title": title}
        if data:
            fcm_data.update(data)
        if kind == "approval":
            disp_title = "⏸ Approval needed"
            disp_body = f"{title}\nwants to run: {detail}"
            priority, tags = "high", "warning"
            fcm_data["body"] = f"wants to run: {detail}"
        elif kind == "finish":
            emoji = "✅" if detail == "done" else "❌"
            disp_title = f"{emoji} Task {detail}"
            disp_body = title
            priority, tags = "default", "robot"
            fcm_data["body"] = title
        else:  # pipeline
            emoji = "🛰" if detail == "done" else "⚠"
            disp_title = f"{emoji} Operation {detail}"
            disp_body = title
            priority, tags = "default", "satellite"
            fcm_data["body"] = title

        # Leg 1: the single configured channel (skipped only when it's "off").
        if (cfg.get("channel") or "off").strip() != "off":
            try:
                await _send(cfg, disp_title, disp_body, priority=priority, tags=tags)
            except Exception:
                pass
        # Leg 2: native FCM — additive, independent of `channel` (fires even when off).
        try:
            await _send_fcm(cfg, title=disp_title, body=disp_body, data=fcm_data)
        except Exception:
            pass
    except Exception:  # a notification must never break the task it's reporting on
        pass


def fire(kind: str, title: str, detail: str = "", data: dict | None = None) -> None:
    """Fire-and-forget from a running event loop — schedule the push and return."""
    try:
        asyncio.get_running_loop().create_task(_notify(kind, title, detail, data))
    except RuntimeError:
        pass  # no loop (shouldn't happen from the async runner) — just skip
