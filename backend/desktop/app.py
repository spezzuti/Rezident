"""Rezident desktop shell — the PyInstaller GUI entry point.

Wraps the existing single uvicorn process in a native window:

  1. point all writes at %LOCALAPPDATA%\\Rezident and bind loopback (env set
     BEFORE importing agentos, since config.py reads env at import time),
  2. run uvicorn in a daemon thread on the Windows Proactor loop (required so
     the Claude SDK / verify.py / git can spawn subprocesses),
  3. wait for the server, run a first-run dependency gate,
  4. open a WebView2 window at http://127.0.0.1:<port>/?token=<token> — the
     frontend's main.tsx shim reads that param and auto-logs the local user in.

AGENTOS_HEADLESS=1 skips the window and blocks, so the identical code path is
curl-verifiable without a display. Run frozen (the .exe) or, in dev, directly:
    AGENTOS_HEADLESS=1 python backend/desktop/app.py
"""

import multiprocessing

multiprocessing.freeze_support()  # must precede any real work on frozen Windows

import json  # noqa: E402
import os  # noqa: E402
import sys  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import urllib.request  # noqa: E402
from pathlib import Path  # noqa: E402

# When run as a plain script (dev), put the backend package dir on sys.path so
# `import agentos` resolves. When frozen, PyInstaller already bundles it.
_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

HEADLESS = os.environ.get("AGENTOS_HEADLESS") == "1"


def _ensure_stdio() -> None:
    """A windowed (console=False) frozen app has sys.stdout/stderr == None, so
    anything that touches them crashes — uvicorn's log formatter does
    sys.stdout.isatty(), and our print()s / logging's StreamHandler write to
    them. Point them at a log file under the app home (also a debuggable log on
    the user's machine). Must run before uvicorn.Config / agentos.main import."""
    if sys.stdout is not None and sys.stderr is not None:
        return
    stream = None
    try:
        local = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
        home = Path(local) / "Rezident" if local else Path.home() / "Rezident"
        logdir = home / "logs"
        logdir.mkdir(parents=True, exist_ok=True)
        stream = open(logdir / "agentos.log", "a", encoding="utf-8", buffering=1)
    except Exception:
        try:
            stream = open(os.devnull, "w")
        except Exception:
            return
    if sys.stdout is None:
        sys.stdout = stream
    if sys.stderr is None:
        sys.stderr = stream


def _suppress_child_windows() -> None:
    """A windowed (no-console) app that spawns console programs — claude (via the
    SDK), git, bash.exe -lc, and the ~12 `<tool> --version` probes in the env scan
    — flashes a console window per spawn. Default every child to CREATE_NO_WINDOW
    so the desktop stays clean. Patches subprocess.Popen, which asyncio's Proactor
    subprocess transport AND anyio.open_process both construct, so it also covers
    the SDK's internal claude spawn we can't otherwise reach. Windows only; pipes
    are unaffected, so subprocess stdout capture still works."""
    if os.name != "nt":
        return
    try:
        import subprocess

        CREATE_NO_WINDOW = 0x08000000
        NEW_CONSOLE_OR_DETACHED = 0x00000010 | 0x00000008  # can't be combined with CREATE_NO_WINDOW
        _orig_init = subprocess.Popen.__init__

        def _init(self, *args, **kwargs):
            flags = kwargs.get("creationflags", 0)
            if not flags & NEW_CONSOLE_OR_DETACHED:
                kwargs["creationflags"] = flags | CREATE_NO_WINDOW
            return _orig_init(self, *args, **kwargs)

        subprocess.Popen.__init__ = _init
    except Exception:
        pass


def _prepare_environment() -> None:
    """Point the app at a per-user writable home and loopback, before agentos import."""
    # Opt into desktop mode: %LOCALAPPDATA% data dir, loopback bind, generated
    # token, no backend/.env — so a from-source launch matches the frozen app.
    os.environ.setdefault("AGENTOS_DESKTOP", "1")
    os.environ.setdefault("AGENTOS_HOST", "127.0.0.1")

    # Best-effort autodetect of external deps that won't be at config defaults on a
    # fresh box; only set when found so the resolver/probe can still search.
    if "AGENTOS_GIT_BASH_PATH" not in os.environ:
        import shutil

        git = shutil.which("git")
        candidates = []
        if git:
            candidates.append(Path(git).resolve().parent.parent / "bin" / "bash.exe")
        candidates += [
            Path(r"C:\Program Files\Git\bin\bash.exe"),
            Path(r"C:\Program Files (x86)\Git\bin\bash.exe"),
        ]
        for c in candidates:
            try:
                if c.exists():
                    os.environ["AGENTOS_GIT_BASH_PATH"] = str(c)
                    break
            except OSError:
                continue


_singleton_handle = None  # kept alive for the process lifetime so the mutex holds


def _acquire_single_instance() -> bool:
    """True if we are the first instance. A second desktop launch must NOT start
    a second server against the shared %LOCALAPPDATA% database — that would run a
    duplicate scheduler (double-firing paid agent runs) and its startup
    orphan-sweep would flip the first instance's live tasks to 'failed'.

    Per-session ("Local\\") mutex — per-user by nature, never blocks other
    Windows accounts. Non-Windows or any failure returns True (don't block)."""
    global _singleton_handle
    try:
        import ctypes

        _singleton_handle = ctypes.windll.kernel32.CreateMutexW(None, False, "Local\\Rezident-SingleInstance")
        ERROR_ALREADY_EXISTS = 183
        return ctypes.windll.kernel32.GetLastError() != ERROR_ALREADY_EXISTS
    except Exception:
        return True


class ThreadedServer:
    """uvicorn.Server run in a worker thread with signal handlers disabled
    (they only install on the main thread)."""

    def __init__(self, app, host: str, port: int):
        import uvicorn

        class _Server(uvicorn.Server):
            def install_signal_handlers(self) -> None:  # noqa: D401
                pass

        # loop='asyncio' -> ProactorEventLoop on Windows (never a Selector policy).
        # use_colors=False so the log formatter never calls sys.stdout.isatty()
        # (belt-and-suspenders alongside _ensure_stdio for windowed mode).
        config = uvicorn.Config(app, host=host, port=port, loop="asyncio", log_level="info", use_colors=False)
        self._server = _Server(config)
        self._thread = threading.Thread(target=self._server.run, daemon=True, name="agentos-uvicorn")

    def start(self) -> None:
        self._thread.start()

    def stop(self, timeout: float = 10.0) -> None:
        self._server.should_exit = True
        self._thread.join(timeout=timeout)


def _wait_up(port: int, timeout: float = 30.0) -> bool:
    deadline = time.monotonic() + timeout
    url = f"http://127.0.0.1:{port}/api/health"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.25)
    return False


def _fetch_readiness(port: int) -> dict | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/readiness", timeout=4) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        return None


def _warn_missing_deps(readiness: dict) -> None:
    """Best-effort native warning when a REQUIRED dependency is absent, so the
    user learns why tasks would fail instead of hitting a silent deep error."""
    missing = [c for c in readiness.get("checks", []) if c.get("severity") == "required" and not c.get("ok")]
    if not missing:
        return
    lines = ["Rezident is missing something it needs to run agents:", ""]
    for c in missing:
        lines.append(f"  ✗ {c['label']} — {c.get('fix_hint', '')}")
    lines += ["", "You can continue, but tasks will fail until these are installed.",
              "The System page inside Rezident shows the full checklist."]
    text = "\n".join(lines)
    try:
        import ctypes

        ctypes.windll.user32.MessageBoxW(0, text, "Rezident — setup needed", 0x30)  # MB_ICONWARNING
    except Exception:
        print(text, flush=True)


def _webview2_available() -> bool:
    try:
        from agentos.environment import _webview2_present

        return _webview2_present()
    except Exception:
        return False


def _style_title_bar(*_args) -> None:
    """Windows 11: tint the native title bar to the vault-console palette
    (immersive dark mode + DWMWA_CAPTION_COLOR/TEXT_COLOR) so the window chrome
    matches the theme instead of stock white. The attributes don't exist on
    Windows 10 — every failure is silent and the stock bar remains."""
    try:
        import ctypes

        hwnd = 0
        try:
            import webview

            handle = webview.windows[0].native.Handle  # WinForms Form (EdgeChromium backend)
            hwnd = int(getattr(handle, "ToInt64", lambda: handle)())
        except Exception:
            hwnd = ctypes.windll.user32.FindWindowW(None, "Rezident")
        if not hwnd:
            return
        dwm = ctypes.windll.dwmapi

        def set_attr(attr: int, value: int) -> int:
            v = ctypes.c_int(value)
            return dwm.DwmSetWindowAttribute(hwnd, attr, ctypes.byref(v), ctypes.sizeof(v))

        hr_dark = set_attr(20, 1)           # DWMWA_USE_IMMERSIVE_DARK_MODE
        hr_cap = set_attr(35, 0x001A1510)   # DWMWA_CAPTION_COLOR (COLORREF 0x00BBGGRR) = vault charcoal #10151a
        hr_txt = set_attr(36, 0x00C6D8DF)   # DWMWA_TEXT_COLOR = bone #dfd8c6
        print(f"title bar styled (hwnd={hwnd} hr={hr_dark:#x},{hr_cap:#x},{hr_txt:#x})", flush=True)
    except Exception as exc:  # noqa: BLE001 — cosmetic; log to the app log and move on
        print(f"title bar styling skipped: {type(exc).__name__}: {exc}", flush=True)


def _open_window(app_url: str, server: "ThreadedServer | None") -> None:
    """Open the native WebView2 window; fall back to a tray icon + default
    browser when the WebView2 runtime (or pywebview) is unavailable.
    server=None = attach mode: the window fronts an external instance (the boot
    service), so closing it must not stop anything."""
    if _webview2_available():
        try:
            import webview

            # Let the boot-sequence audio play without a first click: browsers gate
            # audio behind a user gesture, but this is our own desktop shell. The
            # WebView2 loader reads this env var; append to any existing args.
            _autoplay = "--autoplay-policy=no-user-gesture-required"
            _extra = os.environ.get("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "")
            if _autoplay not in _extra:
                os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = (_extra + " " + _autoplay).strip()

            window = webview.create_window("Rezident", app_url, width=1400, height=900, min_size=(1024, 680))
            window.events.shown += _style_title_bar
            webview.start()  # blocks the main thread until the window closes
            return
        except Exception as exc:  # pragma: no cover - GUI path
            print(f"WebView2 window failed ({exc}); falling back to browser", flush=True)

    import webbrowser

    webbrowser.open(app_url)
    if server is None:
        return  # attached to an external instance — nothing here to keep alive
    try:
        from desktop.tray import run_tray

        run_tray(app_url, server)  # blocks until the user picks Quit
    except Exception:
        # Last resort: no tray available — keep the server alive until killed.
        print("Rezident is running in your browser. Close this window to quit.", flush=True)
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass


def main() -> None:
    # CLI: `Rezident.exe --service [--host 0.0.0.0]` — the boot-service entry the
    # System page's opt-in autostart task uses. Headless, no window; --host must
    # land in the env BEFORE agentos imports read it.
    args = sys.argv[1:]
    service_mode = "--service" in args
    if "--host" in args:
        i = args.index("--host")
        if i + 1 < len(args):
            os.environ["AGENTOS_HOST"] = args[i + 1]
    headless = HEADLESS or service_mode

    _ensure_stdio()              # windowed mode has no console; must precede uvicorn/logging
    _suppress_child_windows()    # no console-window flashes from claude/git/bash/probes
    _prepare_environment()

    from agentos.config import ensure_token, settings
    from agentos.runtime import clear_runtime, pick_port, probe_running, read_runtime, write_runtime

    token = ensure_token()

    # Single-instance: if Rezident is already running for this user, surface it
    # instead of starting a second server against the shared database.
    if not _acquire_single_instance():
        info = read_runtime()
        running_url = info.get("url") if info else None
        if headless:
            print(f"Rezident already running at {running_url or '(unknown)'}", flush=True)
        elif running_url:
            import webbrowser

            webbrowser.open(running_url.rstrip("/") + f"/#token={token}")
        sys.exit(0)

    # Cross-session guard + attach: the mutex above is per-session, so it can't
    # see the boot service (which runs in its own S4U session). If a live
    # instance answers on the recorded port, never start a second server against
    # the shared database — a duplicate scheduler double-fires paid agent runs.
    # Headless exits; the GUI opens its window against the running instance.
    running = probe_running()
    if running:
        url = (running.get("url") or "").rstrip("/")
        if headless:
            print(f"Rezident already running at {url or '(unknown)'} — not starting a second server", flush=True)
            sys.exit(0)
        _open_window(f"{url}/#token={token}", None)
        sys.exit(0)

    from agentos.main import app

    settings.ensure_dirs()
    port = pick_port(settings.host, settings.port)
    write_runtime(settings.host, port)

    server = ThreadedServer(app, settings.host, port)
    server.start()

    if not _wait_up(port):
        if headless:
            # never MessageBox in a non-interactive (boot-service) session — it
            # would block forever on a dialog nobody can see
            clear_runtime()
            sys.exit("Rezident server did not start")
        _warn_missing_deps({"checks": [{"severity": "required", "ok": False, "label": "Local server", "fix_hint": "server did not start"}]})
        sys.exit("Rezident server did not start")

    # Token rides the URL fragment (#), not the query string: fragments are never
    # sent to the server (kept out of the access log) and are less persistent in
    # browser history on the WebView2-absent fallback path.
    app_url = f"http://127.0.0.1:{port}/#token={token}"

    if headless:
        print(f"Rezident headless up on 127.0.0.1:{port}", flush=True)
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass
        finally:
            server.stop()
            clear_runtime()
        return

    readiness = _fetch_readiness(port)
    if readiness and not readiness.get("ok"):
        _warn_missing_deps(readiness)

    try:
        _open_window(app_url, server)
    finally:
        server.stop()
        clear_runtime()


if __name__ == "__main__":
    main()
