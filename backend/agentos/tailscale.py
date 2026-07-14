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
import os
import shutil
import subprocess

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


def _sweep_stale_helpers() -> None:
    """Kill any tailscale-helper.exe left behind by a previous (hard-killed)
    server. Two helpers sharing one tsnet identity flap the WireGuard data path
    while BOTH report Running — the tailnet looks up but times out (observed
    live 2026-07-14: four orphans after a day of dev restarts). Any helper
    alive when WE are about to spawn ours is stale by definition: the
    single-instance guard prevents a second server, and one node identity can
    only back one process. Image-name taskkill is deliberate — no psutil dep."""
    if os.name != "nt":
        return
    try:
        subprocess.run(
            ["taskkill", "/F", "/IM", "tailscale-helper.exe"],
            capture_output=True, timeout=10,
        )  # exit 128 = none found; either way we proceed
    except Exception:  # noqa: BLE001 — the sweep is best-effort
        pass


def _bind_to_job(pid: int):
    """Tie the helper's lifetime to THIS process via a Windows Job object with
    KILL_ON_JOB_CLOSE: when the server dies — cleanly or by Stop-Process -Force —
    the OS closes our job handle and kills the helper with it. Returns the job
    handle (must stay referenced) or None; failure is non-fatal because the
    stale sweep above catches anything that still slips through."""
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class _BASIC(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_int64),
                ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class _IO(ctypes.Structure):
            _fields_ = [(n, ctypes.c_uint64) for n in (
                "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

        class _EXTENDED(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", _BASIC),
                ("IoInfo", _IO),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
        JobObjectExtendedLimitInformation = 9
        PROCESS_SET_QUOTA = 0x0100
        PROCESS_TERMINATE = 0x0001

        k32 = ctypes.windll.kernel32
        job = k32.CreateJobObjectW(None, None)
        if not job:
            return None
        info = _EXTENDED()
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not k32.SetInformationJobObject(
            job, JobObjectExtendedLimitInformation, ctypes.byref(info), ctypes.sizeof(info)
        ):
            k32.CloseHandle(job)
            return None
        hproc = k32.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, False, pid)
        if not hproc:
            k32.CloseHandle(job)
            return None
        ok = k32.AssignProcessToJobObject(job, hproc)
        k32.CloseHandle(hproc)
        if not ok:
            k32.CloseHandle(job)
            return None
        return job
    except Exception:  # noqa: BLE001 — job binding is hardening, never a blocker
        return None


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

        _sweep_stale_helpers()  # a prior hard-killed server may have orphaned one

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
        _ts["job"] = _bind_to_job(proc.pid)  # helper dies with us, even on a hard kill
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
