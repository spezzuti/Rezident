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


# All fields (cache/snooze/skip/auto_check/last_check) share ONE JSON settings blob.
# Every writer used to read-whole-object -> modify -> write-whole-object with an
# await in between, so the background poller's cache write could clobber a snooze/
# skip/auto_check that a user set concurrently (and vice versa). _mutate_state
# serializes writers and RE-READS the current blob inside the lock immediately
# before writing, so each op merges only its own field(s) onto the latest state
# instead of overwriting with a stale snapshot.
_state_lock = asyncio.Lock()


async def _mutate_state(mutate) -> dict:
    """Atomic read-modify-write of the update settings blob. `mutate(st)` edits the
    freshly-read dict in place; the merged result is persisted and returned."""
    async with _state_lock:
        st = await get_state()
        mutate(st)
        await _write_state(st)
        return st


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

    def _apply(s: dict) -> None:
        # merge onto the LATEST state (re-read inside the lock) so this cache write
        # can't clobber a snooze/skip/auto_check a user set while we were fetching.
        s["cache"] = cache
        s["last_check"] = cache["checked_at"]
        if s.get("skip_version") and is_newer(cache["latest"], s["skip_version"]):
            s["skip_version"] = ""

    await _mutate_state(_apply)
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
    # The UIs render "v{latest}" — expose the bare number, not the raw tag,
    # or the banner reads "vv0.1.12". Internal compares stay tag-tolerant.
    if latest[:1] in ("v", "V"):
        latest = latest[1:]
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
    deadline = (_now() + timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    await _mutate_state(lambda s: s.__setitem__("snooze_until", deadline))
    return await status()


async def skip() -> dict:
    """Persist the current latest tag as skipped; check() auto-clears it once a
    newer-than-skipped release lands, so skipping one build never blinds the user
    to the next."""
    def _apply(s: dict) -> None:
        latest = ((s.get("cache") or {}).get("latest") or "").strip()
        if latest:
            s["skip_version"] = latest

    await _mutate_state(_apply)
    return await status()


async def unskip() -> dict:
    """Reverse a skip — clear the parked tag so the held build is offered again.
    The 'RECONSIDER'/'DIG IT UP' control the UIs surface on the skipped state."""
    await _mutate_state(lambda s: s.__setitem__("skip_version", ""))
    return await status()


async def unsnooze() -> dict:
    """Reverse a snooze — drop the NOT-NOW deadline so the prompt resurfaces now.
    Backs the 'SHOW NOW'/'WAKE IT' control on the snoozed state."""
    await _mutate_state(lambda s: s.__setitem__("snooze_until", ""))
    return await status()


async def set_auto_check(value: bool) -> dict:
    await _mutate_state(lambda s: s.__setitem__("auto_check", bool(value)))
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
    `chcp 65001` prologue so cmd switches to a codepage that can decode them.

    newline="" is LOAD-BEARING: the body already uses \\r\\n, and without it
    write_text's text-mode translation turns every \\r\\n into \\r\\r\\n. That
    trailing \\r sticks to the LABELS (:wait/:swap/:swapped), so `goto swapped`
    can't find `:swapped\\r` — the batch aborts mid-swap and the exe is never
    replaced (the "installing… never restarts" bug)."""
    if os.name == "nt":
        try:
            helper.write_text(body, encoding="mbcs", newline="")
            return helper
        except UnicodeEncodeError:
            # A path char is outside the ANSI codepage — run this batch under
            # UTF-8 (chcp 65001) so the embedded paths survive intact.
            helper.write_text("@chcp 65001 >NUL\r\n" + body, encoding="utf-8", newline="")
            return helper
    helper.write_text(body, encoding="utf-8", newline="")
    return helper


def _trail() -> Path:
    """The helper's breadcrumb log. Every swap step appends here so a field
    failure ("closed and never came back") is diagnosable from one file."""
    return _work_dir() / "rezident_update.log"


def _crumb(step: str) -> str:
    """A batch line appending a timestamped breadcrumb to the trail log.
    The space before >> is LOAD-BEARING: a step ending in a digit (e.g. an
    expanded %ERRORLEVEL%) would otherwise fuse into `0>>` — a handle
    redirect — and the breadcrumb silently vanishes."""
    return f'echo [%date% %time%] {step} >>"{_trail()}"\r\n'


def _task_cleanup(task: str) -> str:
    """Batch lines removing the Task Scheduler entry that launched this helper
    and the hidden-launcher shim beside it (%~dpn0.vbs = this batch's own path
    with a .vbs extension). Both harmlessly no-op on the detached fallback."""
    lines = 'del /Q "%~dpn0.vbs" >NUL 2>&1\r\n'
    if task:
        lines += f'schtasks /Delete /TN "{task}" /F >NUL 2>&1\r\n'
    return lines


def _write_hidden_launcher(helper: Path) -> Path:
    """A wscript shim so the scheduler-launched helper runs with NO console —
    a visible cmd box mid-update reads like a malfunction (field request).
    wscript is a GUI-subsystem exe; Run(..., 0, False) starts the batch hidden.
    The batch deletes this shim on its way out (see _task_cleanup)."""
    vbs = helper.with_suffix(".vbs")
    body = f'CreateObject("WScript.Shell").Run "cmd.exe /c ""{helper}""", 0, False\r\n'
    try:
        vbs.write_text(body, encoding="mbcs", newline="")
    except UnicodeEncodeError:
        # non-ANSI path chars: wscript reads UTF-16 with a BOM fine
        vbs.write_text(body, encoding="utf-16", newline="")
    return vbs


def _write_portable_helper(pid: int, exe: Path, new: Path, task: str = "") -> Path:
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
        + _crumb(f"portable helper started (waiting on pid {pid})")
        + ":wait\r\n"
        f'tasklist /FI "PID eq {pid}" 2>NUL | find "{pid}" >NUL\r\n'
        'if "%ERRORLEVEL%"=="0" ( ping -n 2 127.0.0.1 >NUL & goto wait )\r\n'
        + _crumb("app exited; swapping exe")
        + f'move /Y "{exe}" "{old}" >NUL 2>&1\r\n'
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
        + _crumb("swap FAILED after retries; restoring old exe")
        + f'if exist "{old}" move /Y "{old}" "{exe}" >NUL 2>&1\r\n'
        f'start "" "{exe}"\r\n'
        + _task_cleanup(task)
        + '(goto) 2>nul & del "%~f0"\r\n'
        ":swapped\r\n"
        + _crumb("swap done; relaunching")
        + f'start "" "{exe}"\r\n'
        ":: only now, with the new exe verifiably in place, drop the backup\r\n"
        f'if exist "{exe}" del /Q "{old}" >NUL 2>&1\r\n'
        + _task_cleanup(task)
        + '(goto) 2>nul & del "%~f0"\r\n'
    )
    return _write_cmd(helper, body)


def _write_installer_helper(pid: int, setup: Path, install_location: str, task: str = "") -> Path:
    """PID-wait then run the fresh installer silently and relaunch the installed exe."""
    helper = _work_dir() / f"rezident_swap_{pid}.cmd"
    target_exe = str(Path(install_location) / _ASSET_PORTABLE) if install_location else ""
    relaunch = f'start "" "{target_exe}"\r\n' if target_exe else ""
    body = (
        "@echo off\r\n"
        ":: installer self-update - waits for Rezident to exit, runs the new setup\r\n"
        ":: silently (no reboot, no dialogs), then relaunches the installed app.\r\n"
        + _crumb(f"installer helper started (waiting on pid {pid})")
        + ":wait\r\n"
        f'tasklist /FI "PID eq {pid}" 2>NUL | find "{pid}" >NUL\r\n'
        'if "%ERRORLEVEL%"=="0" ( ping -n 2 127.0.0.1 >NUL & goto wait )\r\n'
        + _crumb("app exited; running the setup silently")
        + f'"{setup}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART\r\n'
        + _crumb("setup exit code %ERRORLEVEL%")
        + ":: on a non-zero exit the install failed: KEEP the setup exe (deliberate -\r\n"
        ":: it's the crash evidence a user attaches to a bug report) and still\r\n"
        ":: relaunch the currently-installed (old) app so they're never stranded.\r\n"
        "if errorlevel 1 goto relaunch\r\n"
        f'del /Q "{setup}" >NUL 2>&1\r\n'
        ":relaunch\r\n"
        + _crumb("relaunching the installed app")
        + f"{relaunch}"
        + _task_cleanup(task)
        + '(goto) 2>nul & del "%~f0"\r\n'
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


def _launch_helper(helper: Path, task: str) -> str:
    """Run the swap helper OUTSIDE our process tree, come what may.

    Field evidence (2026-07-14, reproduced live): a byte-perfect helper sat on
    disk while the detached cmd child never executed a single line — a child of
    the exiting app dies with it in real environments, DETACHED_PROCESS or not.
    The Task Scheduler is immune: the helper runs under the scheduler service,
    outside our tree, our job, and our console. The helper deletes its own task
    when done; the detached spawn stays as the fallback for locked-down boxes.
    Returns which path launched it ('schtasks' | 'detached') for the trail log."""
    shim = _write_hidden_launcher(helper)
    tr = f'wscript.exe //B //Nologo "{shim}"'
    try:
        create = subprocess.run(
            ["schtasks", "/Create", "/F", "/TN", task, "/SC", "ONCE", "/ST", "00:00", "/TR", tr],
            capture_output=True, timeout=15,
        )
        run = subprocess.run(["schtasks", "/Run", "/TN", task], capture_output=True, timeout=15)
        if create.returncode == 0 and run.returncode == 0:
            return "schtasks"
        log.warning(
            "schtasks handoff failed (create=%s run=%s: %s %s) — falling back to detached spawn",
            create.returncode, run.returncode,
            (create.stderr or b"").decode(errors="replace").strip(),
            (run.stderr or b"").decode(errors="replace").strip(),
        )
    except Exception:  # noqa: BLE001 — schtasks missing/blocked: fall back
        log.warning("schtasks handoff unavailable — falling back to detached spawn", exc_info=True)
    _spawn_detached(helper)
    return "detached"


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

        # Refuse to swap the binary out from under a SECOND live Rezident. The swap
        # helper waits only on THIS process's pid, so a rival instance would keep the
        # old exe locked (or get replaced mid-run) — corruption, not an update. The
        # dispatch lease is the liveness signal: if another holder is alive (not us,
        # not an empty slot), stop before staging anything. Reuses the existing update
        # -error UI in both themes (the _job error field the panels already render).
        from .lease import lease

        info = await lease.describe()
        if info.get("alive") and info.get("holder_pid") not in (None, os.getpid()):
            _set_job("error", error="another Rezident is running — close it, then retry the update")
            return

        _set_job("swapping", detail="staging the new build")
        pid = os.getpid()
        task = f"RezidentUpdate{pid}"
        if flavor == "installer":
            entry = _read_uninstall_entry() or {}
            helper = _write_installer_helper(pid, target, entry.get("InstallLocation") or "", task=task)
            planned = [f'"{target}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART']
        else:
            exe, new = _portable_paths()
            helper = _write_portable_helper(pid, exe, new, task=task)
            planned = [f'move "{new}" -> "{exe}"', f'start "" "{exe}"']

        if dry:
            # DRYRUN: helper is written (the swap script is the deliverable), but we
            # spawn nothing, replace nothing, and exit nothing.
            _job["planned"] = planned
            _job["helper"] = str(helper)
            _set_job("restarting", pct=100, detail=f"[DRYRUN] would run {helper.name} and restart")
            _job["dry"] = True
            return

        mode = _launch_helper(helper, task)
        try:
            with open(_trail(), "a", encoding="utf-8") as f:
                f.write(f"[{utcnow()}] armed {helper.name} via {mode} (updating to {latest})\n")
        except OSError:
            pass
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
