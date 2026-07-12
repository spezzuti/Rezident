import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .config import ensure_token, resolve_claude_cli, settings
from .db import db
from .paths import frontend_dist, is_desktop

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("agentos")

# Resolves to <repo>/frontend/dist in dev and <_MEIPASS>/frontend/dist when frozen.
FRONTEND_DIST = frontend_dist()


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not settings.token:
        # No env/.env token. Desktop self-provisions on first run; a dev / raw
        # `uvicorn agentos.main:app` launch reads the encrypted token file at
        # <data_dir>/token when one exists — so the master token need not sit in
        # plaintext in backend/.env (security finding #1). Only a truly
        # unconfigured dev box (no env AND no token file) still gets the raise.
        if is_desktop() or settings.token_path.exists():
            ensure_token()
        if not settings.token:
            raise RuntimeError(
                "AGENTOS_TOKEN is not set and no token file exists. Generate one:\n"
                '  python -c "import secrets; print(secrets.token_urlsafe(32))"\n'
                "and put AGENTOS_TOKEN=<value> in backend/.env (or let the desktop app provision one)."
            )
    # A double-clicked GUI app inherits a stale login-time PATH, so claude/git/node
    # installed after login are invisible until we prepend their dirs here. Do this
    # before anything spawns a subprocess (SDK, verify.py, git init).
    _augment_path()

    # Env-scrub agent child-spawn environments (Sandbox, Feature 2) as a belt-and-
    # suspenders net: the dev (__main__.serve) and desktop (app.py) entrypoints already
    # install this before uvicorn starts, but a raw `uvicorn agentos.main:app` launch
    # would otherwise spawn agent children unscrubbed. Idempotent (sentinel-guarded).
    from . import spawn_guard

    spawn_guard.install_child_env_scrub()

    # WS ?token= access-log redaction: the __main__ (headless) and desktop (app.py)
    # entrypoints already install this, but a raw `uvicorn agentos.main:app` launch
    # would otherwise log live tokens. Idempotent (filter is installed once).
    from .logfilter import install_access_log_redaction

    install_access_log_redaction()

    settings.ensure_dirs()
    _fence_scratch_dir()
    await db.connect()

    from . import relay
    from .lease import lease
    from .scheduler import scheduler
    from .task_manager import manager

    # Grab the dispatcher lease before the queue/scheduler start, so a standby
    # instance never drains queued work or fires schedules against the shared DB.
    await lease.start()
    await manager.start()
    await scheduler.start()

    # Reverse-tunnel relay: a clean no-op unless relay:config.enabled is set
    # (off by default — see docs/RELAY.md); nothing activates without operator config.
    await relay.start_relay()

    # Desktop-only auto-update poll: check for a newer build on a boot delay + every
    # few hours. Gated on is_desktop() so dev-from-repo never phones the release API.
    update_task = None
    if is_desktop():
        import asyncio

        from .update import poll_loop

        update_task = asyncio.create_task(poll_loop())

    log.info("Rezident up on %s:%s (db: %s)", settings.host, settings.port, settings.db_path)
    try:
        yield
    finally:
        from . import relay
        from .integrations import shutdown_tunnels
        from .lease import lease
        from .orchestrator import orchestrator

        if update_task is not None:
            update_task.cancel()
        await orchestrator.shutdown()
        await scheduler.stop()
        await manager.shutdown()
        await lease.stop()
        await shutdown_tunnels()
        await relay.shutdown_relay()
        await db.close()


def _augment_path() -> None:
    """Prepend the dirs holding claude/git/node onto PATH so subprocess spawns
    resolve them even when the app was launched with a stale/minimal PATH."""
    import shutil

    extra: list[str] = []
    claude = resolve_claude_cli()
    if claude:
        extra.append(str(claude.parent))
    try:
        gb = settings.git_bash_path
        if gb.exists():
            # .../Git/bin/bash.exe -> add .../Git/bin and .../Git/cmd
            extra.append(str(gb.parent))
            extra.append(str(gb.parent.parent / "cmd"))
    except OSError:
        pass
    node = shutil.which("node")
    if node:
        extra.append(str(Path(node).parent))

    current = os.environ.get("PATH", "")
    parts = current.split(os.pathsep)
    add = [d for d in extra if d and d not in parts]
    if add:
        os.environ["PATH"] = os.pathsep.join(add + parts)


def _fence_scratch_dir() -> None:
    """Make the scratch dir its own git repo. Claude Code resolves its project
    root by walking up to the nearest .git — without this fence, general tasks
    running in data/scratch would see the Rezident repo itself as their project
    and write files there. No-ops (with a warning) when git is unavailable so a
    git-less machine still boots."""
    import shutil
    import subprocess

    if shutil.which("git") is None:
        log.warning("git not found on PATH — scratch dir not fenced; install Git for Windows")
        return
    scratch_git = settings.scratch_dir / ".git"
    if not scratch_git.exists():
        subprocess.run(
            ["git", "init", "-q"], cwd=settings.scratch_dir, check=False, capture_output=True
        )


def create_app() -> FastAPI:
    app = FastAPI(title="Rezident", lifespan=lifespan)

    from .api import approvals, dreams, knowledge, memory, notifications, pairing, pipelines, profiles, schedules, system, tasks, update, ws

    app.include_router(system.router)
    app.include_router(tasks.router)
    app.include_router(approvals.router)
    app.include_router(dreams.router)
    app.include_router(knowledge.router)
    app.include_router(memory.router)
    app.include_router(notifications.router)
    app.include_router(pairing.router)
    app.include_router(pipelines.router)
    app.include_router(profiles.router)
    app.include_router(schedules.router)
    app.include_router(update.router)
    app.include_router(ws.router)

    # Personal sound overrides (README › Sounds): drop WAVs into data\sounds and
    # both UIs prefer them over the built-ins. Served UNAUTHENTICATED on purpose —
    # <audio> elements can't carry a Bearer header, and sounds aren't secrets.
    sounds_dir = settings.data_dir / "sounds"
    try:
        sounds_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass

    @app.get("/user-sounds/index.json")
    def user_sounds_index() -> list[str]:
        try:
            return sorted(p.stem.lower() for p in sounds_dir.glob("*.wav") if p.is_file())
        except OSError:
            return []

    if sounds_dir.is_dir():
        app.mount("/user-sounds", StaticFiles(directory=sounds_dir), name="user-sounds")

    if FRONTEND_DIST.exists():
        app.mount("/", SPAStaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
    return app


class SPAStaticFiles(StaticFiles):
    """Serve the built frontend with SPA fallback to index.html.

    Also stamps clickjacking/framing defenses on every served response. The GRID//OS
    bridge (the deck's postMessage → REST channel) trusts same-origin framing only, so
    the host document must refuse to be framed by any other origin. `frame-ancestors
    'self'` still permits our own same-origin /cyber/ deck iframe to load. The CSP is
    intentionally scoped to frame-ancestors only — the deck is a large inline-script/
    style document, so no script-src/style-src is set here."""

    async def get_response(self, path: str, scope):
        from starlette.exceptions import HTTPException as StarletteHTTPException

        try:
            response = await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code == 404:
                response = await super().get_response("index.html", scope)
            else:
                raise
        response.headers["Content-Security-Policy"] = "frame-ancestors 'self'"
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
        return response


app = create_app()
