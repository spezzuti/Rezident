"""Tests for desktop self-update (agentos/update.py + api/update.py).

Standalone (the project ships no pytest): run with the venv python

    backend/.venv/Scripts/python.exe backend/tests/test_update.py

Unit tests fake the DB (no network, no real sqlite). The integration block
stands up a local http.server serving a fake releases/latest + asset + SHA256SUMS
and points AGENTOS_UPDATE_API_BASE at it, so nothing ever touches the public repo.
"""

import asyncio
import hashlib
import http.server
import json
import os
import shutil
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ -> import agentos.*

from agentos import update  # noqa: E402


# ---- fakes -------------------------------------------------------------------

class FakeDB:
    """Key/value store matching the two SQL statements get_state/_write_state use."""

    def __init__(self):
        self.store: dict[str, str] = {}

    async def fetch_one(self, sql, params=()):
        k = params[0]
        return {"value": self.store[k]} if k in self.store else None

    async def execute(self, sql, params=()):
        self.store[params[0]] = params[1]


def _use_fakedb():
    fake = FakeDB()
    update.db = fake
    return fake


async def _seed(*, latest, skip="", snooze="", auto=True, fresh=True):
    """Seed update state with a (fresh) cache so status() never hits the network."""
    now = update.utcnow()
    st = dict(update._DEFAULT_STATE)
    st["auto_check"] = auto
    st["skip_version"] = skip
    st["snooze_until"] = snooze
    st["cache"] = {"latest": latest, "release_url": "https://ex.test/rel",
                   "notes": "notes", "assets": [], "checked_at": now if fresh else "2000-01-01T00:00:00.000Z"}
    st["last_check"] = st["cache"]["checked_at"]
    await update._write_state(st)


# ---- unit: semver ------------------------------------------------------------

async def test_semver_matrix():
    assert update.is_newer("0.1.10", "0.1.9") is True, "0.1.10 must beat 0.1.9 (numeric, not string)"
    assert update.is_newer("v0.2.0", "0.1.0") is True, "leading v is stripped"
    assert update.is_newer("0.1.0", "0.1.0") is False, "equal is not newer"
    assert update.is_newer("0.1.0", "0.2.0") is False, "older is not newer"
    assert update.is_newer("0.2", "0.1.9") is True, "short tuple pads with zeros (0.2.0 > 0.1.9)"
    assert update.is_newer("garbage", "0.1.0") is False, "malformed latest -> not newer"
    assert update.is_newer("0.1.0", "garbage") is False, "malformed current -> not newer"
    assert update.is_newer("1.0.0-rc1", "0.9.0") is True, "prerelease suffix stripped to numeric core"


# ---- unit: snooze ------------------------------------------------------------

async def test_snooze_set_and_expire():
    _use_fakedb()
    await _seed(latest="0.2.0")
    await update.snooze()
    st = await update.get_state()
    assert update._snoozed(st) is True, "snooze sets a future deadline"
    s = await update.status()
    assert s["snoozed"] is True and s["update_available"] is False, "snooze suppresses the prompt"

    # a past deadline no longer snoozes
    st["snooze_until"] = "2000-01-01T00:00:00.000Z"
    await update._write_state(st)
    st2 = await update.get_state()
    assert update._snoozed(st2) is False, "past deadline expires"
    s2 = await update.status()
    assert s2["update_available"] is True, "after expiry the prompt returns"


# ---- unit: skip --------------------------------------------------------------

async def test_skip_suppresses_and_newer_clears(monkeypatch=None):
    _use_fakedb()
    await _seed(latest="0.2.0")
    await update.skip()
    st = await update.get_state()
    assert st["skip_version"] == "0.2.0", "skip persists the latest tag"
    s = await update.status()
    assert s["skipped"] is True and s["update_available"] is False, "skipped build is suppressed"

    # a newer-than-skipped release clears the skip on the next check
    async def fake_fetch():
        return {"latest": "0.3.0", "release_url": "https://ex.test/r3", "notes": "",
                "assets": [], "checked_at": update.utcnow()}
    orig_fetch = update._fetch_latest
    update._fetch_latest = fake_fetch
    try:
        await update.check(force=True)
        st2 = await update.get_state()
        assert st2["skip_version"] == "", "a newer-than-skipped release auto-clears the skip"
        s2 = await update.status()
        assert s2["update_available"] is True, "the newer build is offered"
    finally:
        update._fetch_latest = orig_fetch


# ---- unit: flavor ------------------------------------------------------------

async def test_flavor_detection():
    orig_exe = sys.executable
    orig_reg = update._read_uninstall_entry
    orig_meipass = getattr(sys, "_MEIPASS", None)
    try:
        # installer: uninstall key present AND InstallLocation is a parent of the exe
        base = Path(tempfile.gettempdir()) / "Rez_flavor" / "Programs" / "Rezident"
        sys.executable = str(base / "Rezident.exe")
        update._read_uninstall_entry = lambda: {"InstallLocation": str(base), "QuietUninstallString": "x"}
        assert update.detect_flavor() == "installer", "exe under InstallLocation -> installer"

        # portable: no uninstall key
        update._read_uninstall_entry = lambda: None
        assert update.detect_flavor() == "portable", "no uninstall key -> portable"

        # portable: key present but InstallLocation is NOT a parent of the exe
        update._read_uninstall_entry = lambda: {"InstallLocation": str(Path(tempfile.gettempdir()) / "elsewhere")}
        assert update.detect_flavor() == "portable", "unrelated InstallLocation -> portable"

        # onefile detection: _MEIPASS differs from the exe dir
        sys._MEIPASS = str(Path(tempfile.gettempdir()) / "Rez_flavor" / "_MEI12345")
        assert update._is_onefile() is True, "_MEIPASS != exe dir -> onefile"

        # any failure -> unknown
        def boom():
            raise RuntimeError("registry exploded")
        update._read_uninstall_entry = boom
        assert update.detect_flavor() == "unknown", "read failure degrades to unknown"
    finally:
        sys.executable = orig_exe
        update._read_uninstall_entry = orig_reg
        if orig_meipass is None:
            if hasattr(sys, "_MEIPASS"):
                del sys._MEIPASS
        else:
            sys._MEIPASS = orig_meipass


# ---- unit: status matrix -----------------------------------------------------

async def test_status_matrix():
    _use_fakedb()
    update.__version__ = "0.1.0"

    await _seed(latest="0.2.0")
    s = await update.status()
    assert s["newer"] and s["update_available"], "newer + unskipped + unsnoozed -> available"
    assert s["current"] == "0.1.0" and s["latest"] == "0.2.0"

    await _seed(latest="0.2.0", skip="0.2.0")
    s = await update.status()
    assert s["skipped"] and not s["update_available"], "skipped build -> not available"

    future = update._now().replace(year=update._now().year + 1).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    await _seed(latest="0.2.0", snooze=future)
    s = await update.status()
    assert s["snoozed"] and not s["update_available"], "snoozed -> not available"

    await _seed(latest="0.1.0")
    s = await update.status()
    assert not s["newer"] and not s["update_available"], "same version -> up to date"

    await _seed(latest="0.2.0", auto=False)
    s = await update.status()
    assert s["auto_check"] is False, "auto-check reflects the stored setting"
    assert s["release_url"], "status always carries an open-releases link (no dead end)"


# ---- unit: unskip / unsnooze (no dead-end from a held build) -----------------

async def test_unskip_and_unsnooze_clear():
    _use_fakedb()
    update.__version__ = "0.1.0"

    # skip then unskip → the held build is offered again
    await _seed(latest="0.2.0")
    await update.skip()
    s = await update.status()
    assert s["skipped"] and not s["update_available"], "skip suppresses"
    s = await update.unskip()
    assert not s["skipped"] and s["update_available"], "unskip re-offers the held build"

    # snooze then unsnooze → the prompt resurfaces immediately
    future = update._now().replace(year=update._now().year + 1).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    await _seed(latest="0.2.0", snooze=future)
    s = await update.status()
    assert s["snoozed"] and not s["update_available"], "snooze suppresses"
    s = await update.unsnooze()
    assert not s["snoozed"] and s["update_available"], "unsnooze resurfaces the prompt now"


# ---- unit: flavor edge — frozen ONEDIR outside the installer is NOT portable --

async def test_flavor_onedir_frozen_unknown():
    orig_exe = sys.executable
    orig_reg = update._read_uninstall_entry
    orig_meipass = getattr(sys, "_MEIPASS", None)
    orig_frozen = getattr(sys, "frozen", None)
    try:
        base = Path(tempfile.gettempdir()) / "Rez_onedir"
        sys.executable = str(base / "Rezident.exe")
        update._read_uninstall_entry = lambda: None  # no installer key
        sys.frozen = True

        # ONEDIR: _MEIPASS == exe dir → a loose frozen folder whose exe is one file
        # among an _internal tree; a bare exe swap would brick it → unknown.
        sys._MEIPASS = str(base)
        assert update._is_onefile() is False, "onedir: _MEIPASS == exe dir"
        assert update.detect_flavor() == "unknown", "frozen onedir outside installer -> unknown"

        # ONEFILE: _MEIPASS != exe dir → a single self-contained swappable exe → portable.
        sys._MEIPASS = str(base / "_MEI98765")
        assert update._is_onefile() is True, "onefile: _MEIPASS != exe dir"
        assert update.detect_flavor() == "portable", "frozen onefile portable -> portable"
    finally:
        sys.executable = orig_exe
        update._read_uninstall_entry = orig_reg
        if orig_frozen is None:
            if hasattr(sys, "frozen"):
                del sys.frozen
        else:
            sys.frozen = orig_frozen
        if orig_meipass is None:
            if hasattr(sys, "_MEIPASS"):
                del sys._MEIPASS
        else:
            sys._MEIPASS = orig_meipass


# ---- unit: swap-helper survives non-ASCII user paths (C:\Users\José\…) --------

async def test_helper_encoding_unicode_paths():
    if os.name != "nt":
        return  # cmd.exe codepage behavior is Windows-only
    for label, name in (("latin", "José"), ("cjk", "更新データ")):
        d = Path(tempfile.mkdtemp())
        os.environ["AGENTOS_UPDATE_DIR"] = str(d)
        try:
            exe = d / name / "Rezident.exe"
            new = exe.with_name(exe.name + ".new")
            helper = update._write_portable_helper(4321, exe, new)  # must NOT raise
            assert helper.exists(), f"{label}: helper written"
            raw = helper.read_bytes()
            fallback = raw.startswith(b"@chcp 65001")
            text = raw.decode("utf-8") if fallback else raw.decode("mbcs")
            assert name in text, f"{label}: the non-ASCII path survived into the helper"
            # a char the ANSI codepage can't hold MUST take the chcp 65001 fallback;
            # one it can hold stays on plain mbcs (no needless chcp).
            try:
                str(exe).encode("mbcs")
                ansi_ok = True
            except UnicodeEncodeError:
                ansi_ok = False
            if ansi_ok:
                assert not fallback, f"{label}: ANSI-representable path stays on mbcs (no chcp)"
            else:
                assert fallback, f"{label}: non-ANSI path needs a chcp 65001 prologue"
        finally:
            os.environ.pop("AGENTOS_UPDATE_DIR", None)
            shutil.rmtree(d, ignore_errors=True)


# ---- unit: poller cache-write must not clobber a concurrent snooze (F6) ------

async def test_poller_cache_write_preserves_concurrent_snooze():
    """The background poller's check() and a user snooze() share one JSON settings
    blob. Before F6 the poller read the whole object, fetched (slow), then wrote the
    whole object back — clobbering a snooze the user set in between. The atomic
    read-modify-write must merge, so the snooze survives AND the cache still lands."""
    _use_fakedb()
    update.__version__ = "0.1.0"
    # Fresh cache: the poller's check(force=True) still refetches (force ignores the
    # TTL), but snooze()'s internal status()->check(force=False) reads the fresh cache
    # WITHOUT fetching — otherwise it would re-enter the slow stub and deadlock.
    await _seed(latest="0.2.0")

    started = asyncio.Event()
    release = asyncio.Event()

    async def slow_fetch():
        started.set()
        await release.wait()  # hold the "network" open until the snooze has landed
        return {"latest": "0.3.0", "release_url": "u", "notes": "",
                "assets": [], "checked_at": update.utcnow()}

    orig = update._fetch_latest
    update._fetch_latest = slow_fetch
    try:
        poll = asyncio.create_task(update.check(force=True))
        await started.wait()   # the poll is now parked mid-fetch, before it writes
        await update.snooze()  # user snoozes while the poll is in flight
        release.set()          # let the poll finish and write its cache
        await poll
    finally:
        update._fetch_latest = orig

    st = await update.get_state()
    assert update._snoozed(st) is True, "the snooze set mid-poll must survive the cache write"
    assert (st.get("cache") or {}).get("latest") == "0.3.0", "the poll's cache write still landed"


# ---- integration: mock release server ----------------------------------------

# Two DISTINCT payloads → two DISTINCT sha256s. SHA256SUMS lists a line per file,
# so a portable download that matches its own line (and NOT the setup line) proves
# _fetch_sha_for selects the right line by filename, not just "first line wins".
_PORTABLE_BYTES = b"REZIDENT-PORTABLE-BUILD-" + b"p" * 4096
_SETUP_BYTES = b"REZIDENT-INSTALLER-BUILD-" + b"s" * 8192


class _Mock:
    tag = "v0.9.0"
    good_sha = True


class _Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):  # silence
        pass

    def _send(self, code, body, ctype="text/plain"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        base = f"http://{self.headers.get('Host')}"
        if self.path.endswith("/releases/latest"):
            body = json.dumps({
                "tag_name": _Mock.tag,
                "html_url": "https://example.test/releases/" + _Mock.tag,
                "body": "fake release notes",
                "assets": [
                    {"name": "Rezident.exe", "browser_download_url": base + "/dl/Rezident.exe"},
                    {"name": "Rezident-Setup.exe", "browser_download_url": base + "/dl/Rezident-Setup.exe"},
                    {"name": "SHA256SUMS", "browser_download_url": base + "/dl/SHA256SUMS"},
                ],
            }).encode()
            self._send(200, body, "application/json")
        elif self.path == "/dl/Rezident.exe":
            self._send(200, _PORTABLE_BYTES, "application/octet-stream")
        elif self.path == "/dl/Rezident-Setup.exe":
            self._send(200, _SETUP_BYTES, "application/octet-stream")
        elif self.path == "/dl/SHA256SUMS":
            if _Mock.good_sha:
                psha = hashlib.sha256(_PORTABLE_BYTES).hexdigest()
                ssha = hashlib.sha256(_SETUP_BYTES).hexdigest()
            else:
                psha = ssha = "0" * 64
            txt = f"{psha}  Rezident.exe\n{ssha}  Rezident-Setup.exe\n"
            self._send(200, txt.encode(), "text/plain")
        else:
            self._send(404, b"nope")


class _MockServer:
    def __enter__(self):
        self.httpd = http.server.HTTPServer(("127.0.0.1", 0), _Handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        os.environ["AGENTOS_UPDATE_API_BASE"] = f"http://127.0.0.1:{self.port}"
        return self

    def __exit__(self, *a):
        os.environ.pop("AGENTOS_UPDATE_API_BASE", None)
        self.httpd.shutdown()


async def _real_db(tmp):
    """Reconnect the real sqlite db against a temp data dir (never the live data)."""
    from agentos.config import settings
    from agentos.db import db as real_db
    settings.data_dir = Path(tmp)
    update.db = real_db
    if real_db._conn is not None:
        await real_db.close()
    await real_db.connect()
    return real_db


def _reset_job():
    """Clear the module-global apply job between tests. In production a real apply
    ends by restarting the process (fresh _job); the dry-run leaves state at
    'restarting', which the in-flight guard (now including 'restarting') would treat
    as still-running — so each apply test starts from a clean slate."""
    update._job.clear()
    update._job.update({"state": "idle", "pct": 0, "detail": "", "error": ""})


async def _poll_job(timeout=20.0):
    import time
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        st = update.job_status()
        if st["state"] in ("error", "restarting", "idle") and st["state"] != "checking":
            if st["state"] in ("error", "restarting"):
                return st
        await asyncio.sleep(0.05)
    return update.job_status()


async def test_integration_status_and_roundtrips():
    tmp = tempfile.mkdtemp()
    os.environ["AGENTOS_DESKTOP"] = "1"
    real_db = None
    try:
        with _MockServer():
            real_db = await _real_db(tmp)
            update.__version__ = "0.1.0"

            s = await update.status(force=True)
            # status exposes the BARE number (the UIs render "v{latest}"; the raw
            # tag would read "vv0.9.0" in the banner — the office vv bug)
            assert s["latest"] == "0.9.0", s
            assert s["newer"] and s["update_available"], "desktop status shows the fresh build available"
            assert s["notes"] == "fake release notes"
            assert s["release_url"] == "https://example.test/releases/v0.9.0"

            # snooze round-trip
            s = await update.snooze()
            assert s["snoozed"] and not s["update_available"], "snooze round-trip suppresses"

            # skip round-trip (clear snooze first so skip is the acting suppressor)
            st = await update.get_state(); st["snooze_until"] = ""; await update._write_state(st)
            s = await update.skip()
            assert s["skipped"] and s["skipped"] and not s["update_available"], "skip round-trip suppresses"

            # settings round-trip
            s = await update.set_auto_check(False)
            assert s["auto_check"] is False
            s = await update.set_auto_check(True)
            assert s["auto_check"] is True

            # check round-trip (force refetch)
            s = await update.status(force=True)
            assert s["latest"] == "0.9.0"
    finally:
        os.environ.pop("AGENTOS_DESKTOP", None)
        if real_db is not None:
            await real_db.close()
        shutil.rmtree(tmp, ignore_errors=True)


async def test_integration_apply_dryrun_writes_helper():
    tmp = tempfile.mkdtemp()
    sandbox = tempfile.mkdtemp()
    os.environ["AGENTOS_DESKTOP"] = "1"
    os.environ["AGENTOS_UPDATE_DRYRUN"] = "1"
    os.environ["AGENTOS_UPDATE_DIR"] = sandbox
    _Mock.good_sha = True
    real_db = None
    orig_reg = update._read_uninstall_entry  # save so the monkeypatch never leaks
    try:
        with _MockServer():
            real_db = await _real_db(tmp)
            _reset_job()
            # portable flavor (no installer registry on the build box)
            update._read_uninstall_entry = lambda: None

            await update.start_apply()
            job = await _poll_job()
            # reaching 'restarting' means download + VERIFY both passed — and since the
            # portable payload hashes to its OWN SHA256SUMS line (distinct from the setup
            # line), that proves _fetch_sha_for picked the right line, not just line 1.
            assert job["state"] == "restarting", job
            assert job.get("dry") is True, "dry-run must not really restart"

            helper = Path(job["helper"])
            assert helper.exists(), "dry-run still writes the swap helper (it IS the deliverable)"
            body = helper.read_text(encoding="mbcs" if os.name == "nt" else "utf-8")
            assert "tasklist" in body and "PID eq" in body, "helper has the PID-wait loop"
            assert "move /Y" in body, "helper moves the new exe into place"
            assert "start \"\"" in body, "helper relaunches the app"
            # H1: the swap must be restore-safe — retry loop + restore-on-failure branch
            assert ":swap" in body and ":restore" in body and ":swapped" in body, "helper has retry + restore branches"
            assert "if exist" in body, "backup is only deleted once the new exe verifiably exists"

            # nothing replaced/exited: the real exe is untouched, .new sits in the sandbox
            assert Path(sys.executable).exists(), "the running exe was not replaced"
            assert any(p.name.endswith(".new") for p in Path(sandbox).iterdir()), "download landed in the sandbox"
    finally:
        for k in ("AGENTOS_DESKTOP", "AGENTOS_UPDATE_DRYRUN", "AGENTOS_UPDATE_DIR"):
            os.environ.pop(k, None)
        update._read_uninstall_entry = orig_reg
        if real_db is not None:
            await real_db.close()
        shutil.rmtree(tmp, ignore_errors=True)
        shutil.rmtree(sandbox, ignore_errors=True)


async def test_integration_checksum_mismatch_aborts():
    tmp = tempfile.mkdtemp()
    sandbox = tempfile.mkdtemp()
    os.environ["AGENTOS_DESKTOP"] = "1"
    os.environ["AGENTOS_UPDATE_DRYRUN"] = "1"
    os.environ["AGENTOS_UPDATE_DIR"] = sandbox
    _Mock.good_sha = False  # server serves a wrong checksum
    real_db = None
    orig_reg = update._read_uninstall_entry  # save so the monkeypatch never leaks
    try:
        with _MockServer():
            real_db = await _real_db(tmp)
            _reset_job()
            update._read_uninstall_entry = lambda: None

            await update.start_apply()
            job = await _poll_job()
            assert job["state"] == "error", job
            assert "checksum" in job["error"].lower(), job
            # aborts BEFORE writing the helper, and deletes the discarded download
            assert not any(p.suffix == ".cmd" for p in Path(sandbox).iterdir()), "no helper written on mismatch"
            assert not any(p.name.endswith(".new") for p in Path(sandbox).iterdir()), "bad download discarded"
    finally:
        _Mock.good_sha = True
        update._read_uninstall_entry = orig_reg
        for k in ("AGENTOS_DESKTOP", "AGENTOS_UPDATE_DRYRUN", "AGENTOS_UPDATE_DIR"):
            os.environ.pop(k, None)
        if real_db is not None:
            await real_db.close()
        shutil.rmtree(tmp, ignore_errors=True)
        shutil.rmtree(sandbox, ignore_errors=True)


async def test_apply_refuses_when_not_newer():
    """M3: apply must refuse when a fresh check shows no newer build — otherwise any
    token holder could trigger a pointless download+swap+restart to the same version."""
    tmp = tempfile.mkdtemp()
    os.environ["AGENTOS_DESKTOP"] = "1"
    os.environ["AGENTOS_UPDATE_DRYRUN"] = "1"
    real_db = None
    orig_ver = update.__version__
    orig_reg = update._read_uninstall_entry
    try:
        with _MockServer():
            real_db = await _real_db(tmp)
            _reset_job()
            update._read_uninstall_entry = lambda: None
            update.__version__ = "0.9.0"  # already at the mock's latest tag v0.9.0
            await update.start_apply()
            job = await _poll_job()
            assert job["state"] == "error", job
            assert "newer" in job["error"].lower(), job
    finally:
        update.__version__ = orig_ver
        update._read_uninstall_entry = orig_reg
        for k in ("AGENTOS_DESKTOP", "AGENTOS_UPDATE_DRYRUN"):
            os.environ.pop(k, None)
        if real_db is not None:
            await real_db.close()
        shutil.rmtree(tmp, ignore_errors=True)


async def test_apply_refuses_without_desktop_frozen():
    tmp = tempfile.mkdtemp()
    real_db = None
    try:
        real_db = await _real_db(tmp)
        os.environ.pop("AGENTOS_UPDATE_DRYRUN", None)  # not frozen, not dry-run
        job = await update.start_apply()
        assert job["state"] == "error", "apply refuses on a non-frozen, non-dryrun copy"
        assert "packaged app" in job["error"], job

        # and the auto-poll no-ops when not in desktop mode (no prompting off-desktop)
        os.environ.pop("AGENTOS_DESKTOP", None)
        await asyncio.wait_for(update.poll_loop(), timeout=2.0)  # returns immediately
    finally:
        if real_db is not None:
            await real_db.close()
        shutil.rmtree(tmp, ignore_errors=True)


# ---- Chunk D: refuse self-update while a rival live instance holds the lease --

async def test_apply_refuses_with_rival_live_instance():
    """A second live Rezident (dispatch lease alive under a DIFFERENT pid) must block
    the swap BEFORE anything is staged — the helper only waits on THIS pid, so it
    would corrupt the rival. Job ends error with the operator-facing message, and no
    swap helper is written."""
    tmp = tempfile.mkdtemp()
    sandbox = tempfile.mkdtemp()
    os.environ["AGENTOS_DESKTOP"] = "1"
    os.environ["AGENTOS_UPDATE_DRYRUN"] = "1"
    os.environ["AGENTOS_UPDATE_DIR"] = sandbox
    _Mock.good_sha = True
    real_db = None
    orig_reg = update._read_uninstall_entry
    from agentos.lease import lease
    orig_describe = lease.describe
    try:
        with _MockServer():
            real_db = await _real_db(tmp)
            update.__version__ = "0.1.0"
            _reset_job()
            update._read_uninstall_entry = lambda: None  # portable flavor

            async def rival_alive():
                return {"held": False, "holder_pid": os.getpid() + 1, "since": "x", "alive": True}

            lease.describe = rival_alive  # type: ignore[assignment]

            await update.start_apply()
            job = await _poll_job()
            assert job["state"] == "error", job
            assert "another rezident is running" in job["error"].lower(), job
            assert not any(p.suffix == ".cmd" for p in Path(sandbox).iterdir()), "no helper written when a rival is live"
    finally:
        lease.describe = orig_describe  # type: ignore[assignment]
        update._read_uninstall_entry = orig_reg
        for k in ("AGENTOS_DESKTOP", "AGENTOS_UPDATE_DRYRUN", "AGENTOS_UPDATE_DIR"):
            os.environ.pop(k, None)
        if real_db is not None:
            await real_db.close()
        shutil.rmtree(tmp, ignore_errors=True)
        shutil.rmtree(sandbox, ignore_errors=True)


async def test_apply_proceeds_when_lease_holder_is_self():
    """The same-pid holder (or a dead/empty lease) is US — the update proceeds to
    write the helper exactly as before."""
    tmp = tempfile.mkdtemp()
    sandbox = tempfile.mkdtemp()
    os.environ["AGENTOS_DESKTOP"] = "1"
    os.environ["AGENTOS_UPDATE_DRYRUN"] = "1"
    os.environ["AGENTOS_UPDATE_DIR"] = sandbox
    _Mock.good_sha = True
    real_db = None
    orig_reg = update._read_uninstall_entry
    from agentos.lease import lease
    orig_describe = lease.describe
    try:
        with _MockServer():
            real_db = await _real_db(tmp)
            update.__version__ = "0.1.0"
            _reset_job()
            update._read_uninstall_entry = lambda: None

            async def self_holder():
                return {"held": True, "holder_pid": os.getpid(), "since": "x", "alive": True}

            lease.describe = self_holder  # type: ignore[assignment]

            await update.start_apply()
            job = await _poll_job()
            assert job["state"] == "restarting", job
            assert job.get("dry") is True
            assert Path(job["helper"]).exists(), "same-pid holder proceeds and writes the helper"
    finally:
        lease.describe = orig_describe  # type: ignore[assignment]
        update._read_uninstall_entry = orig_reg
        for k in ("AGENTOS_DESKTOP", "AGENTOS_UPDATE_DRYRUN", "AGENTOS_UPDATE_DIR"):
            os.environ.pop(k, None)
        if real_db is not None:
            await real_db.close()
        shutil.rmtree(tmp, ignore_errors=True)
        shutil.rmtree(sandbox, ignore_errors=True)


# ---- runner ------------------------------------------------------------------

TESTS = [
    test_semver_matrix,
    test_snooze_set_and_expire,
    test_skip_suppresses_and_newer_clears,
    test_unskip_and_unsnooze_clear,
    test_poller_cache_write_preserves_concurrent_snooze,
    test_flavor_detection,
    test_flavor_onedir_frozen_unknown,
    test_helper_encoding_unicode_paths,
    test_status_matrix,
    test_integration_status_and_roundtrips,
    test_integration_apply_dryrun_writes_helper,
    test_integration_checksum_mismatch_aborts,
    test_apply_refuses_when_not_newer,
    test_apply_refuses_without_desktop_frozen,
    test_apply_refuses_with_rival_live_instance,
    test_apply_proceeds_when_lease_holder_is_self,
]


def main() -> int:
    failed = 0
    for t in TESTS:
        try:
            asyncio.run(t())
            print(f"PASS  {t.__name__}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            import traceback
            print(f"FAIL  {t.__name__}: {type(exc).__name__}: {exc}")
            traceback.print_exc()
    print(f"\n{len(TESTS) - failed}/{len(TESTS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
