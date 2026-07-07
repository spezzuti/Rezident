"""Headless server entry: `python -m agentos`.

Runs the ASGI app on this process's main thread (so the Windows Proactor loop —
required for spawning claude.exe / git / bash — is owned by the main thread).
Used for dev-parity runs and as the desktop shell's child-process fallback if
threaded uvicorn ever misbehaves with off-main-thread subprocess spawning.
"""

import uvicorn

from .config import ensure_token, settings
from .runtime import clear_runtime, pick_port, write_runtime


def serve() -> None:
    ensure_token()
    settings.ensure_dirs()
    port = pick_port(settings.host, settings.port)
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
