"""Headless server entry: `python -m agentos`.

Runs the ASGI app on this process's main thread (so the Windows Proactor loop —
required for spawning claude.exe / git / bash — is owned by the main thread).
Used for dev-parity runs and as the desktop shell's child-process fallback if
threaded uvicorn ever misbehaves with off-main-thread subprocess spawning.
"""

import uvicorn

from .config import ensure_token, settings
from .runtime import clear_runtime, pick_port, probe_running, write_runtime


def serve() -> None:
    ensure_token()
    settings.ensure_dirs()
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
