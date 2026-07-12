"""TAILSCALE — bundled embedded-node remote access (out-of-box, no VPS).

Manages the bundled `tailscale-helper.exe` (a tsnet userspace node, source in
desktop/tailscale-helper/) as a child process: it joins the operator's tailnet as
its OWN node — no wintun driver, no admin prompt — and reverse-proxies the tailnet
to this box's loopback service (127.0.0.1:<settings.port>). The phone (also on the
tailnet) then reaches Rezident at the node's MagicDNS name; pairing advertises that
address automatically (see api/pairing._default_base_url).

Shape mirrors relay.py / integrations.py's managed subprocesses: spawn via
asyncio.create_subprocess_exec (so the desktop window-suppressing + env-scrub Popen
patches cover the child), a registry so shutdown can terminate it, fully guarded so
a failure never breaks boot. Unlike relay's loopback health-wait, readiness here is
asynchronous — the helper may sit in NeedsLogin until the operator approves the auth
URL — so start does NOT block: the helper streams newline-delimited JSON status on
stdout ({state, auth_url, ip, dns, error}) which a watcher task folds into `_status`,
and the Connect UI polls status() until state == "Running".

OFF BY DEFAULT: start_tailscale() no-ops unless tailscale:config.enabled is set
(the operator flips it by clicking Connect). Config persists, so on the next boot
the node re-joins from its saved tsnet state with no re-auth.
"""

import asyncio
import json
import logging
import shutil

from .config import settings
from .db import db

log = logging.getLogger("agentos.tailscale")

# tailscale:config lives in the settings table as JSON. OFF BY DEFAULT.
#   enabled  — master switch; False means start_tailscale() no-ops
#   hostname — the tailnet node name (MagicDNS label)
#   authkey  — optional Tailscale auth key for headless/kiosk join; blank = the
#              default interactive auth-URL login
_TS_KEY = "tailscale:config"
_DEFAULT_CONFIG = {"enabled": False, "hostname": "rezident", "authkey": ""}

# At most one helper child per process. {"proc": <asyncio subprocess>, "watcher": <task>}
_ts: dict = {}

# Latest status the helper reported (mutated IN PLACE so readers share one object).
_status: dict = {"state": "Stopped"}


async def _load_config() -> dict:
    """tailscale:config merged over the disabled default. Any read failure (db not
    connected yet, missing table, bad JSON) degrades to the default so
    start_tailscale() stays a no-op. Never raises."""
    cfg = dict(_DEFAULT_CONFIG)
    try:
        row = await db.fetch_one("SELECT value FROM settings WHERE key = ?", (_TS_KEY,))
    except Exception:  # noqa: BLE001 — a boot-time read must never break startup
        return cfg
    if row:
        try:
            cfg.update(json.loads(row["value"]))
        except (TypeError, ValueError):
            pass
    return cfg


async def _save_config(cfg: dict) -> None:
    await db.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (_TS_KEY, json.dumps(cfg)),
    )


def _helper_binary() -> str | None:
    """The bundled tsnet helper: resolved next to the app (resource_dir()/bin, the
    frozen _MEIPASS or the repo root in dev, mirroring paths.frontend_dist), else on
    PATH. None when absent so start_tailscale() logs and no-ops instead of crashing."""
    from .paths import resource_dir

    p = resource_dir() / "bin" / "tailscale-helper.exe"
    if p.exists():
        return str(p)
    return shutil.which("tailscale-helper")


def _set_status(data: dict) -> None:
    _status.clear()
    _status.update(data)


def _is_running() -> bool:
    proc = _ts.get("proc")
    return proc is not None and proc.returncode is None and _status.get("state") == "Running"


async def _watch_stdout(proc) -> None:
    """Fold the helper's newline-delimited JSON status into `_status` until stdout
    closes, then record why it stopped. Mirrors integrations._login_watch's drain."""
    try:
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            try:
                data = json.loads(line.decode(errors="replace").strip())
            except (ValueError, TypeError):
                continue
            if isinstance(data, dict) and data.get("state"):
                _set_status(data)
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 — a watcher hiccup must not crash the loop
        pass
    # stdout closed → the helper exited. Reflect it unless we already hold a terminal
    # error the helper emitted on the way out.
    code = getattr(proc, "returncode", None)
    if _status.get("state") != "Error":
        _set_status({"state": "Stopped", "error": "" if code in (0, None) else f"helper exited (code {code})"})


async def start_tailscale() -> None:
    """Launch the tsnet helper when tailscale:config.enabled — otherwise a clean
    no-op (the default). Non-blocking: it spawns the helper + a stdout watcher and
    returns immediately; the node's state (NeedsLogin → Running) streams in async.
    Fully guarded so a failure never keeps the app from booting."""
    try:
        if _ts.get("proc") is not None and _ts["proc"].returncode is None:
            return  # already running — one helper per process

        cfg = await _load_config()
        if not cfg.get("enabled"):
            return  # OFF BY DEFAULT

        binary = _helper_binary()
        if not binary:
            log.warning("tailscale enabled but tailscale-helper.exe was not found — not starting")
            _set_status({"state": "Error", "error": "tailscale-helper.exe not found"})
            return

        settings.ensure_dirs()
        state_dir = settings.data_dir / "tailscale"
        args = [
            binary,
            "--data-dir", str(state_dir),
            "--target", f"127.0.0.1:{settings.port}",
            "--hostname", (cfg.get("hostname") or "rezident").strip() or "rezident",
            "--port", str(settings.port),
        ]
        authkey = (cfg.get("authkey") or "").strip()
        if authkey:
            args += ["--authkey", authkey]

        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,  # helper reports errors on stdout; tsnet's own logs are noise
            )
        except (FileNotFoundError, OSError) as exc:
            log.warning("tailscale: could not launch the helper (%s) — not starting", exc)
            _set_status({"state": "Error", "error": str(exc)})
            return

        _ts["proc"] = proc
        _set_status({"state": "Starting"})
        _ts["watcher"] = asyncio.ensure_future(_watch_stdout(proc))
        log.info("tailscale: helper started (tailnet node '%s')", args[6])
    except Exception as exc:  # noqa: BLE001 — startup must never raise on tailscale
        log.warning("tailscale: start_tailscale failed, continuing without it (%s)", exc)


async def shutdown_tailscale() -> None:
    """Terminate the helper + its watcher, if running. Guarded so a shutdown hiccup
    never propagates out of the lifespan teardown (which has no try/except)."""
    w = _ts.get("watcher")
    if w is not None:
        w.cancel()
    proc = _ts.get("proc")
    if proc is not None:
        try:
            proc.terminate()
        except (ProcessLookupError, OSError):
            pass
    _ts.clear()
    _set_status({"state": "Stopped"})


def tailnet_base_url() -> str | None:
    """http://<magicdns-or-ip>:<port> when the node is Running, else None. Used by
    pairing to advertise the tailnet address so the phone connects over WireGuard."""
    if not _is_running():
        return None
    host = (_status.get("dns") or _status.get("ip") or "").strip()
    return f"http://{host}:{settings.port}" if host else None


async def status() -> dict:
    """Live status for GET /api/system/tailscale + the Connect panel."""
    cfg = await _load_config()
    proc = _ts.get("proc")
    alive = proc is not None and proc.returncode is None
    st = dict(_status)
    return {
        "enabled": bool(cfg.get("enabled")),
        "hostname": cfg.get("hostname") or "rezident",
        "running": _is_running(),
        "alive": alive,
        "state": st.get("state") or ("Starting" if alive else "Stopped"),
        "auth_url": st.get("auth_url") or "",
        "ip": st.get("ip") or "",
        "dns": st.get("dns") or "",
        "error": st.get("error") or "",
        "tailnet_url": tailnet_base_url() or "",
    }


async def connect(hostname: str | None = None) -> dict:
    """Enable + start the node (persisted, so it re-joins on the next boot)."""
    cfg = await _load_config()
    cfg["enabled"] = True
    if hostname and hostname.strip():
        cfg["hostname"] = hostname.strip()
    await _save_config(cfg)
    await start_tailscale()
    return await status()


async def disconnect() -> dict:
    """Stop the node + persist it off. tsnet state on disk is kept, so a later
    reconnect re-joins without re-auth."""
    cfg = await _load_config()
    cfg["enabled"] = False
    await _save_config(cfg)
    await shutdown_tailscale()
    return await status()
