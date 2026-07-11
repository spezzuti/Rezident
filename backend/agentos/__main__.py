"""Headless server entry: `python -m agentos`.

Runs the ASGI app on this process's main thread (so the Windows Proactor loop —
required for spawning claude.exe / git / bash — is owned by the main thread).
Used for dev-parity runs and as the desktop shell's child-process fallback if
threaded uvicorn ever misbehaves with off-main-thread subprocess spawning.
"""

import os

import uvicorn

from . import spawn_guard
from .config import ensure_token, record_bind, resolve_bind_host, settings
from .logfilter import install_access_log_redaction
from .runtime import clear_runtime, pick_port, probe_running, write_runtime


def _suppress_child_windows() -> None:
    """Default every spawned child to CREATE_NO_WINDOW so console programs
    (claude via the SDK, git, bash.exe -lc, the env-scan probes) don't flash a
    console window. Mirrors desktop/app.py:_suppress_child_windows exactly, but is
    duplicated (not imported) so the agentos package never has to import the
    desktop package. Idempotent: a sentinel on the wrapped __init__ guards against
    a double-patch. Windows only; pipes are unaffected, so stdout capture works."""
    if os.name != "nt":
        return
    try:
        import subprocess

        orig_init = subprocess.Popen.__init__
        if getattr(orig_init, "_agentos_no_window", False):
            return  # already installed
        CREATE_NO_WINDOW = 0x08000000
        NEW_CONSOLE_OR_DETACHED = 0x00000010 | 0x00000008  # can't be combined with CREATE_NO_WINDOW

        def _init(self, *args, **kwargs):
            flags = kwargs.get("creationflags", 0)
            if not flags & NEW_CONSOLE_OR_DETACHED:
                kwargs["creationflags"] = flags | CREATE_NO_WINDOW
            return orig_init(self, *args, **kwargs)

        _init._agentos_no_window = True  # type: ignore[attr-defined]
        subprocess.Popen.__init__ = _init  # type: ignore[assignment]
    except Exception:  # noqa: BLE001 — never let hardening break a spawn
        pass


_guards_installed = False


def _install_child_spawn_guards() -> None:
    """Bring `python -m agentos` to parity with the desktop shell's child-spawn
    hardening BEFORE anything in serve() can spawn a subprocess. Two composable
    subprocess.Popen patches (each touches only its own kwargs — creationflags vs
    env — so they layer cleanly):
      * window-suppression — no console-window flashes, mirroring the desktop path.
      * env-scrub — rebuild every child's env down to an allowlist so master
        tokens / API keys in os.environ never reach an agent-controlled child (the
        SAME spawn_guard.install_child_env_scrub() the desktop shell calls).
    Ordered window-then-scrub to mirror desktop/app.py:main() exactly, which also
    leaves env-scrub as the OUTERMOST wrapper so spawn_guard's own sentinel guard
    stays authoritative. A module-level flag makes the combined install itself
    double-patch-proof (belt-and-suspenders over each patch's own sentinel).
    Ideally both patches would live behind spawn_guard so both entrypoints route
    through one module; window-suppression stays local here only because
    spawn_guard is outside this change's edit scope."""
    global _guards_installed
    if _guards_installed:
        return
    _suppress_child_windows()
    spawn_guard.install_child_env_scrub()
    _guards_installed = True


def serve() -> None:
    _install_child_spawn_guards()  # env-scrub + no-window, before any subprocess spawn
    ensure_token()
    settings.ensure_dirs()
    # LAN-exposure policy: a non-loopback request (0.0.0.0 etc.) is downgraded to
    # loopback unless the operator opted in (AGENTOS_ALLOW_INSECURE_LAN / Settings).
    # settings.host is overwritten to the effective host so pick_port, write_runtime
    # and uvicorn all bind the same interface. With the override set, 0.0.0.0 binds
    # exactly as before (no regression to the phone/Tailscale dev workflow).
    _requested = settings.host
    _effective, _warning = resolve_bind_host(_requested)
    record_bind(_requested, _effective, _warning)
    settings.host = _effective
    if _warning:
        print(f"[security] {_warning}", flush=True)
    # Scrub the WS ?token=... query param from uvicorn access logs before they hit
    # stdout/the log file — a live credential must never be persisted in plaintext.
    install_access_log_redaction()
    # Never double-serve the shared database (two dispatchers = double-launched
    # paid runs). The boot service and a manual launch live in different
    # sessions, so this HTTP probe — not a mutex — is the guard.
    running = probe_running()
    if running:
        print(f"Rezident already running at {running.get('url')} — not starting a second server", flush=True)
        return
    port = pick_port(settings.host, settings.port)
    if port != settings.port:
        # The configured port is taken. The dispatch lease now makes a second
        # instance harmless, but serving on a random port is still a surprise
        # (bookmarks, tunnels, the desktop shell all expect settings.port), so
        # refuse rather than silently drift.
        print(
            f"Port {settings.port} is in use — refusing to serve on a random port ({port}). "
            "Stop the other Rezident instance first.",
            flush=True,
        )
        return
    write_runtime(settings.host, port)
    try:
        # loop defaults to asyncio (Proactor on Windows) — never force a Selector policy.
        uvicorn.run(
            "agentos.main:app",
            host=settings.host,
            port=port,
            log_level="info",
            factory=False,
        )
    finally:
        clear_runtime()


if __name__ == "__main__":
    serve()
