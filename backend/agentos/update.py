"""Desktop self-update — check GitHub Releases, download + verify, hand off to a
detached swap helper, then ask the running server to exit so the helper can
replace the binary.

Only the packaged Windows app self-updates. Everything here degrades to an
"open the releases page" link when a step is impossible (unknown install flavor,
no network, checksum mismatch) — there is never a dead end.

The GitHub API base is env-overridable (AGENTOS_UPDATE_API_BASE) so a local mock
can serve fake releases in tests without publishing to the public repo; asset
download URLs come from the release JSON, so they follow the mock automatically.
"""

import asyncio
import hashlib
import json
import logging
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

from . import __version__
from .db import db
from .events import utcnow
from .paths import is_desktop, is_frozen

log = logging.getLogger(__name__)

# The installer's Inno Setup AppId — its per-user uninstall key carries the real
# InstallLocation, which is how we tell an installed copy from a portable exe.
_INSTALLER_GUID = "{B3D47A22-9C61-4E8B-A54D-C2E1D5F00001}"
_UNINSTALL_KEY = rf"Software\Microsoft\Windows\CurrentVersion\Uninstall\{_INSTALLER_GUID}_is1"

# Human-facing releases page — the always-valid fallback link every error carries.
RELEASES_URL = "https://github.com/spezzuti/Rezident/releases"

_ASSET_INSTALLER = "Rezident-Setup.exe"
_ASSET_PORTABLE = "Rezident.exe"
_SHA_ASSET = "SHA256SUMS"

_STATE_KEY = "update"
_CACHE_TTL = 6 * 3600          # seconds a cached "latest" is trusted before re-fetching
_POLL_INTERVAL = 6 * 3600      # background auto-check cadence
_BOOT_DELAY = 25               # let the app settle before the first network poke
_DEFAULT_STATE = {
    "auto_check": True,   # pings the depot on boot + every few hours
    "skip_version": "",   # a release the user chose to skip (auto-clears when a newer one lands)
    "snooze_until": "",   # ISO — the NOT NOW deadline; suppresses prompts until it passes
    "last_check": "",
    "cache": None,        # {latest, release_url, notes, assets, checked_at}
}


class UpdateError(Exception):
    """Any failure a caller should surface with a retry + open-releases affordance."""


def _api_base() -> str:
    return os.environ.get("AGENTOS_UPDATE_API_BASE", "https://api.github.com/repos/spezzuti/Rezident").rstrip("/")


# ---- semver ------------------------------------------------------------------

def _parse_version(v: str) -> tuple[int, ...] | None:
    """Dotted-numeric tuple, or None when malformed. Strips a leading 'v' and any
    -prerelease/+build suffix; a non-numeric core is malformed → None (treated as
    'not newer' upstream, so a garbage tag can never trigger an update prompt)."""
    if not isinstance(v, str):
        return None
    v = v.strip()
    if v[:1] in ("v", "V"):
        v = v[1:]
    core = v.split("-", 1)[0].split("+", 1)[0].strip()
    parts = core.split(".") if core else []
    if not parts or not all(p.isdigit() for p in parts):
        return None
    return tuple(int(p) for p in parts)


def is_newer(latest: str, current: str) -> bool:
    """True iff latest > current by numeric-tuple compare (0.1.10 > 0.1.9).
    Either side malformed → False."""
    lt = _parse_version(latest)
    ct = _parse_version(current)
    if lt is None or ct is None:
        return False
    n = max(len(lt), len(ct))
    lt = lt + (0,) * (n - len(lt))
    ct = ct + (0,) * (n - len(ct))
    return lt > ct


# ---- state -------------------------------------------------------------------

async def get_state() -> dict:
    row = await db.fetch_one("SELECT value FROM settings WHERE key = ?", (_STATE_KEY,))
    st = dict(_DEFAULT_STATE)
    if row:
        try:
            st.update(json.loads(row["value"]))
        except (TypeError, json.JSONDecodeError):
            pass
    return st


async def _write_state(st: dict) -> None:
    await db.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (_STATE_KEY, json.dumps(st)),
    )


def _parse_iso(s: str) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _snoozed(st: dict) -> bool:
    dt = _parse_iso(st.get("snooze_until", ""))
    return bool(dt and dt > _now())


def _cache_fresh(cache: dict | None) -> bool:
    if not cache:
        return False
    dt = _parse_iso(cache.get("checked_at", ""))
    return bool(dt and (_now() - dt).total_seconds() < _CACHE_TTL)


# ---- release check -----------------------------------------------------------

async def _fetch_latest() -> dict:
    """GET {API_BASE}/releases/latest (unauthenticated). Raises UpdateError on any
    network/HTTP failure so the caller can fall back to the last cache + a link."""
    url = f"{_api_base()}/releases/latest"
    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            resp = await client.get(url, headers={"Accept": "application/vnd.github+json"})
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as exc:
        raise UpdateError(f"the depot didn't answer: {type(exc).__name__}") from exc
    except (ValueError, json.JSONDecodeError) as exc:
        raise UpdateError("the depot sent something unreadable") from exc
    assets = [
        {"name": a.get("name", ""), "url": a.get("browser_download_url", "")}
        for a in (data.get("assets") or [])
        if a.get("name")
    ]
    return {
        "latest": (data.get("tag_name") or "").strip(),
        "release_url": data.get("html_url") or RELEASES_URL,
        "notes": data.get("body") or "",
        "assets": assets,
        "checked_at": utcnow(),
    }


async def check(force: bool = False) -> dict:
    """Return the latest-release cache, refetching when forced or stale (6h TTL).
    Clears a stale skip when a newer-than-skipped release appears."""
    st = await get_state()
    cache = st.get("cache")
    if not force and _cache_fresh(cache):
        return cache
    cache = await _fetch_latest()
    st["cache"] = cache
    st["last_check"] = cache["checked_at"]
    if st.get("skip_version") and is_newer(cache["latest"], st["skip_version"]):
        st["skip_version"] = ""
    await _write_state(st)
    return cache


async def status(force: bool = False) -> dict:
    """The full status the UIs render. Never raises — a fetch failure carries the
    last known cache plus an `error` string (and the open-releases link stands)."""
    current = __version__
    error = ""
    try:
        cache = await check(force=force)
    except UpdateError as exc:
        st = await get_state()
        cache = st.get("cache") or {}
        error = str(exc)
    st = await get_state()
    latest = (cache or {}).get("latest") or ""
    newer = is_newer(latest, current)
    skipped = bool(latest) and st.get("skip_version") == latest
    snoozed = _snoozed(st)
    return {
        "current": current,
        "latest": latest,
        "newer": newer,
        "update_available": newer and not skipped and not snoozed,
        "flavor": detect_flavor(),
        "auto_check": bool(st.get("auto_check", True)),
        "skipped": skipped,
        "snoozed": snoozed,
        "snooze_until": st.get("snooze_until", ""),
        "release_url": (cache or {}).get("release_url") or RELEASES_URL,
        "notes": (cache or {}).get("notes") or "",
        "checked_at": st.get("last_check", ""),
        "error": error,
    }


async def snooze(hours: int = 24) -> dict:
    """USER'S HARD REQUIREMENT: every prompt has a NOT NOW. Suppress prompts for
    24h without touching skip — the next boot after that re-offers the build."""
    st = await get_state()
    st["snooze_until"] = (_now() + timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    await _write_state(st)
    return await status()


async def skip() -> dict:
    """Persist the current latest tag as skipped; check() auto-clears it once a
    newer-than-skipped release lands, so skipping one build never blinds the user
    to the next."""
    st = await get_state()
    latest = ((st.get("cache") or {}).get("latest") or "").strip()
    if latest:
        st["skip_version"] = latest
    await _write_state(st)
    return await status()


async def unskip() -> dict:
    """Reverse a skip — clear the parked tag so the held build is offered again.
    The 'RECONSIDER'/'DIG IT UP' control the UIs surface on the skipped state."""
    st = await get_state()
    st["skip_version"] = ""
    await _write_state(st)
    return await status()


async def unsnooze() -> dict:
    """Reverse a snooze — drop the NOT-NOW deadline so the prompt resurfaces now.
    Backs the 'SHOW NOW'/'WAKE IT' control on the snoozed state."""
    st = await get_state()
    st["snooze_until"] = ""
    await _write_state(st)
    return await status()


async def set_auto_check(value: bool) -> dict:
    st = await get_state()
    st["auto_check"] = bool(value)
    await _write_state(st)
    return await status()


# ---- install flavor ----------------------------------------------------------

def _read_uninstall_entry() -> dict | None:
    """Read the installer's per-user uninstall key. Returns {InstallLocation,
    QuietUninstallString} or None when absent (portable copy / non-Windows).
    A single seam so tests can monkeypatch the registry read."""
    if os.name != "nt":
        return None
    try:
        import winreg
    except ImportError:
        return None
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _UNINSTALL_KEY) as k:
            out: dict = {}
            for name in ("InstallLocation", "QuietUninstallString"):
                try:
                    out[name] = winreg.QueryValueEx(k, name)[0]
                except OSError:
                    out[name] = ""
            return out
    except OSError:
        return None


def detect_flavor() -> str:
    """'installer' | 'portable' | 'unknown'. Installer = the uninstall key is
    present AND its InstallLocation is a parent of the running exe. Otherwise
    portable. Any failure → unknown (self-update disabled, open-releases stands)."""
    try:
        exe = Path(sys.executable).resolve()
        entry = _read_uninstall_entry()
        loc = (entry or {}).get("InstallLocation") or ""
        if loc:
            try:
                locp = Path(loc).resolve()
                exe.relative_to(locp)
                return "installer"
            except (ValueError, OSError):
                pass
        # No installer registry match → a loose copy. A onefile portable exe is a
        # single self-contained file we can swap in place; a frozen ONEDIR copy
        # running outside the installer (loose folder, no registry key) is NOT —
        # its exe is one file among a whole _internal tree, so a bare exe swap
        # would brick it. Degrade to 'unknown' (the UI falls back to open-releases).
        if is_frozen() and not _is_onefile():
            return "unknown"
        return "portable"
    except Exception:  # noqa: BLE001 — flavor detection must never crash the caller
        return "unknown"


def _is_onefile() -> bool:
    """Onefile self-extracts to sys._MEIPASS, which then differs from the exe dir.
    Only affects logging — both onefile and onedir portable swap the same exe."""
    meipass = getattr(sys, "_MEIPASS", None)
    if not meipass:
        return False
    try:
        return Path(meipass).resolve() != Path(sys.executable).resolve().parent
    except OSError:
        return False


# ---- download + apply --------------------------------------------------------

_job = {"state": "idle", "pct": 0, "detail": "", "error": ""}
_apply_task: asyncio.Task | None = None
_shutdown_hook = None  # set by the desktop shell so apply() can trigger a clean exit


def register_shutdown(fn) -> None:
    """The desktop shell hands us a zero-arg callable that flips uvicorn's
    should_exit, so apply() can end the process once the swap helper is armed."""
    global _shutdown_hook
    _shutdown_hook = fn


def job_status() -> dict:
    return dict(_job)


def _set_job(state: str, *, pct: int | None = None, detail: str = "", error: str = "") -> None:
    _job["state"] = state
    if pct is not None:
        _job["pct"] = max(0, min(100, pct))
    _job["detail"] = detail
    _job["error"] = error


def _work_dir() -> Path:
    """Where downloads + the swap helper land. AGENTOS_UPDATE_DIR sandboxes this
    for tests/dry-runs; otherwise %TEMP%."""
    d = os.environ.get("AGENTOS_UPDATE_DIR")
    return Path(d) if d else Path(tempfile.gettempdir())


def _portable_paths() -> tuple[Path, Path]:
    """(current exe, download target). The '.new' lands beside the exe in a real
    run so the move is same-volume; a sandboxed work dir overrides for tests."""
    exe = Path(sys.executable)
    d = os.environ.get("AGENTOS_UPDATE_DIR")
    new = (Path(d) / (exe.name + ".new")) if d else exe.with_name(exe.name + ".new")
    return exe, new


def _find_asset(assets: list[dict], name: str) -> str:
    for a in assets:
        if a.get("name") == name:
            return a.get("url") or ""
    return ""


async def _download(url: str, target: Path) -> str:
    """Stream url → target, updating job pct, and return the sha256 hex of the bytes."""
    h = hashlib.sha256()
    got = 0
    target.parent.mkdir(parents=True, exist_ok=True)
    async with httpx.AsyncClient(timeout=None, follow_redirects=True) as client:
        async with client.stream("GET", url) as resp:
            resp.raise_for_status()
            total = int(resp.headers.get("Content-Length") or 0)
            with open(target, "wb") as f:
                async for chunk in resp.aiter_bytes(65536):
                    f.write(chunk)
                    h.update(chunk)
                    got += len(chunk)
                    if total:
                        _set_job("downloading", pct=int(got * 100 / total))
    return h.hexdigest()


async def _fetch_sha_for(assets: list[dict], filename: str) -> str:
    """Pull SHA256SUMS from the release and return the expected hex for filename.
    Missing sums file / missing line → UpdateError (we never install unverified)."""
    url = _find_asset(assets, _SHA_ASSET)
    if not url:
        raise UpdateError("no SHA256SUMS published for this release")
    try:
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            text = resp.text
    except httpx.HTTPError as exc:
        raise UpdateError(f"couldn't fetch checksums: {type(exc).__name__}") from exc
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[-1].lstrip("*") == filename:
            return parts[0].lower()
    raise UpdateError(f"no checksum for {filename}")


def _write_cmd(helper: Path, body: str) -> Path:
    """Write a .cmd cmd.exe will read correctly for the paths embedded in it.

    cmd.exe reads a batch file in the console's *ANSI* codepage (mbcs on Windows),
    NOT UTF-8/ASCII — so encoding="ascii" raised UnicodeEncodeError for any user
    path with a non-ASCII char (C:\\Users\\José\\…), locking those users out of
    self-update entirely. Write mbcs when the paths fit the ANSI codepage; if a
    char doesn't (e.g. CJK on a Latin locale), fall back to UTF-8 with a
    `chcp 65001` prologue so cmd switches to a codepage that can decode them."""
    if os.name == "nt":
        try:
            helper.write_text(body, encoding="mbcs")
            return helper
        except UnicodeEncodeError:
            # A path char is outside the ANSI codepage — run this batch under
            # UTF-8 (chcp 65001) so the embedded paths survive intact.
            helper.write_text("@chcp 65001 >NUL\r\n" + body, encoding="utf-8")
            return helper
    helper.write_text(body, encoding="utf-8")
    return helper


def _write_portable_helper(pid: int, exe: Path, new: Path) -> Path:
    """PID-wait swap that can never leave the user without a runnable exe.

    After the app exits we move exe→.old, then move .new→exe with retries (AV
    scanners hold a *transient* lock on a freshly written exe, so a first failure
    is usually gone within seconds). If the new exe still isn't in place after the
    retries we RESTORE .old→exe, relaunch the OLD build, and leave .new on disk for
    inspection — the backup is only deleted once the new exe verifiably exists.
    tasklist+ping is the dependency-free wait loop; the self-delete tail is unchanged."""
    helper = _work_dir() / f"rezident_swap_{pid}.cmd"
    old = str(exe) + ".old"
    body = (
        "@echo off\r\n"
        ":: portable self-update swap - waits for the running Rezident to exit,\r\n"
        ":: then replaces the exe in place. Never runs while the app holds the file.\r\n"
        ":wait\r\n"
        f'tasklist /FI "PID eq {pid}" 2>NUL | find "{pid}" >NUL\r\n'
        'if "%ERRORLEVEL%"=="0" ( ping -n 2 127.0.0.1 >NUL & goto wait )\r\n'
        f'move /Y "{exe}" "{old}" >NUL 2>&1\r\n'
        ":: retry the swap - a transient AV lock on the just-written .new clears fast\r\n"
        "set _tries=0\r\n"
        ":swap\r\n"
        f'move /Y "{new}" "{exe}" >NUL 2>&1\r\n'
        f'if exist "{exe}" goto swapped\r\n'
        "set /a _tries+=1\r\n"
        "if %_tries% GEQ 5 goto restore\r\n"
        "ping -n 3 127.0.0.1 >NUL & goto swap\r\n"
        ":restore\r\n"
        ":: the new build never landed - put the original back so the user is never\r\n"
        ":: left with no exe at all, and keep .new for inspection.\r\n"
        f'if exist "{old}" move /Y "{old}" "{exe}" >NUL 2>&1\r\n'
        f'start "" "{exe}"\r\n'
        '(goto) 2>nul & del "%~f0"\r\n'
        ":swapped\r\n"
        f'start "" "{exe}"\r\n'
        ":: only now, with the new exe verifiably in place, drop the backup\r\n"
        f'if exist "{exe}" del /Q "{old}" >NUL 2>&1\r\n'
        '(goto) 2>nul & del "%~f0"\r\n'
    )
    return _write_cmd(helper, body)


def _write_installer_helper(pid: int, setup: Path, install_location: str) -> Path:
    """PID-wait then run the fresh installer silently and relaunch the installed exe."""
    helper = _work_dir() / f"rezident_swap_{pid}.cmd"
    target_exe = str(Path(install_location) / _ASSET_PORTABLE) if install_location else ""
    relaunch = f'start "" "{target_exe}"\r\n' if target_exe else ""
    body = (
        "@echo off\r\n"
        ":: installer self-update - waits for Rezident to exit, runs the new setup\r\n"
        ":: silently (no reboot, no dialogs), then relaunches the installed app.\r\n"
        ":wait\r\n"
        f'tasklist /FI "PID eq {pid}" 2>NUL | find "{pid}" >NUL\r\n'
        'if "%ERRORLEVEL%"=="0" ( ping -n 2 127.0.0.1 >NUL & goto wait )\r\n'
        f'"{setup}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART\r\n'
        ":: on a non-zero exit the install failed: KEEP the setup exe (deliberate -\r\n"
        ":: it's the crash evidence a user attaches to a bug report) and still\r\n"
        ":: relaunch the currently-installed (old) app so they're never stranded.\r\n"
        "if errorlevel 1 goto relaunch\r\n"
        f'del /Q "{setup}" >NUL 2>&1\r\n'
        ":relaunch\r\n"
        f"{relaunch}"
        '(goto) 2>nul & del "%~f0"\r\n'
    )
    return _write_cmd(helper, body)


def _spawn_detached(helper: Path) -> None:
    """Fire the swap helper as a detached, own-process-group child so it outlives
    this process (which is about to exit) and its own console never flashes."""
    DETACHED_PROCESS = 0x00000008
    CREATE_NEW_PROCESS_GROUP = 0x00000200
    CREATE_NO_WINDOW = 0x08000000
    subprocess.Popen(
        ["cmd.exe", "/c", str(helper)],
        close_fds=True,
        creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW,
    )


def _request_shutdown() -> None:
    if _shutdown_hook is not None:
        try:
            _shutdown_hook()
            return
        except Exception:  # noqa: BLE001 — fall through to the signal path
            log.warning("update shutdown hook failed; signalling self", exc_info=True)
    try:
        import signal
        os.kill(os.getpid(), getattr(signal, "SIGINT", 2))
    except Exception:  # noqa: BLE001
        log.warning("could not request shutdown for update restart", exc_info=True)


async def _run_apply() -> None:
    dry = os.environ.get("AGENTOS_UPDATE_DRYRUN") == "1"
    try:
        _set_job("checking", pct=0, detail="asking the depot for the latest build")
        cache = await check(force=True)
        # Gate on a FRESH status showing a genuinely newer build. We gate on
        # `newer` (not `update_available`) so an explicit apply still works after
        # the UI un-skips/un-snoozes a held build, but a same-version apply from
        # any token holder is refused — no pointless download+swap+restart.
        latest = (cache.get("latest") or "").strip()
        if not is_newer(latest, __version__):
            _set_job("error", error="no newer build to install — you're already current")
            return
        assets = cache.get("assets") or []
        flavor = detect_flavor()
        if flavor == "unknown":
            _set_job("error", error="can't self-update this copy")
            return

        if flavor == "installer":
            asset_name = _ASSET_INSTALLER
            target = _work_dir() / f"Rezident-Setup-{cache.get('latest', 'new')}.exe"
        else:
            asset_name = _ASSET_PORTABLE
            _exe, target = _portable_paths()

        url = _find_asset(assets, asset_name)
        if not url:
            _set_job("error", error=f"release has no {asset_name}")
            return

        _set_job("downloading", pct=0, detail=f"pulling {asset_name}")
        digest = await _download(url, target)

        _set_job("verifying", detail="checking the signature")
        expected = await _fetch_sha_for(assets, asset_name)
        if digest != expected:
            # discard the build for safety — never keep or install unverified bytes
            try:
                target.unlink()
            except OSError:
                pass
            _set_job("error", error="checksum mismatch — build discarded")
            return

        _set_job("swapping", detail="staging the new build")
        pid = os.getpid()
        if flavor == "installer":
            entry = _read_uninstall_entry() or {}
            helper = _write_installer_helper(pid, target, entry.get("InstallLocation") or "")
            planned = [f'"{target}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART']
        else:
            exe, new = _portable_paths()
            helper = _write_portable_helper(pid, exe, new)
            planned = [f'move "{new}" -> "{exe}"', f'start "" "{exe}"']

        if dry:
            # DRYRUN: helper is written (the swap script is the deliverable), but we
            # spawn nothing, replace nothing, and exit nothing.
            _job["planned"] = planned
            _job["helper"] = str(helper)
            _set_job("restarting", pct=100, detail=f"[DRYRUN] would run {helper.name} and restart")
            _job["dry"] = True
            return

        _spawn_detached(helper)
        _set_job("restarting", pct=100, detail="Rezident will restart to finish the update")
        # Let the POST response flush before the server goes down under us.
        try:
            asyncio.get_running_loop().call_later(1.0, _request_shutdown)
        except RuntimeError:
            _request_shutdown()
    except UpdateError as exc:
        _set_job("error", error=str(exc))
    except Exception as exc:  # noqa: BLE001 — any surprise surfaces as a retryable error
        log.warning("update apply failed", exc_info=True)
        _set_job("error", error=f"install failed: {exc}")


async def start_apply() -> dict:
    """Guarded by is_frozen() unless AGENTOS_UPDATE_DRYRUN=1. Kicks off the apply
    worker (idempotent while one is in flight) and returns the current job."""
    global _apply_task
    if not is_frozen() and os.environ.get("AGENTOS_UPDATE_DRYRUN") != "1":
        _set_job("error", error="self-update only works in the packaged app")
        return job_status()
    if _job["state"] in ("checking", "downloading", "verifying", "swapping", "restarting"):
        return job_status()
    _job.pop("planned", None)
    _job.pop("helper", None)
    _job.pop("dry", None)
    _set_job("checking", pct=0, detail="starting")
    _apply_task = asyncio.create_task(_run_apply())
    return job_status()


# ---- background poll ---------------------------------------------------------

async def poll_loop() -> None:
    """Desktop-only auto-check: a short boot delay, then every 6h, refresh the
    cache when auto_check is on. Started from main.py lifespan gated on is_desktop().
    Failures are swallowed — a missed poll must never disturb the running app."""
    if not is_desktop():
        return
    await asyncio.sleep(_BOOT_DELAY)
    while True:
        try:
            st = await get_state()
            if st.get("auto_check", True):
                await check(force=False)
        except UpdateError:
            log.debug("update auto-check: depot unreachable, will retry")
        except Exception:  # noqa: BLE001
            log.debug("update auto-check hiccup", exc_info=True)
        await asyncio.sleep(_POLL_INTERVAL)
