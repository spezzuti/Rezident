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
        if is_desktop():
            # Packaged / desktop app: self-provision a token on first run (persisted).
            ensure_token()
        else:
            raise RuntimeError(
                "AGENTOS_TOKEN is not set. Generate one:\n"
                '  python -c "import secrets; print(secrets.token_urlsafe(32))"\n'
                "and put AGENTOS_TOKEN=<value> in backend/.env"
            )
    # A double-clicked GUI app inherits a stale login-time PATH, so claude/git/node
    # installed after login are invisible until we prepend their dirs here. Do this
    # before anything spawns a subprocess (SDK, verify.py, git init).
    _augment_path()

    settings.ensure_dirs()
    _fence_scratch_dir()
    await db.connect()

    from .scheduler import scheduler
    from .task_manager import manager

    await manager.start()
    await scheduler.start()
    log.info("Rezident up on %s:%s (db: %s)", settings.host, settings.port, settings.db_path)
    try:
        yield
    finally:
        from .integrations import shutdown_tunnels
        from .orchestrator import orchestrator

        await orchestrator.shutdown()
        await scheduler.stop()
        await manager.shutdown()
        await shutdown_tunnels()
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

    from .api import approvals, dreams, memory, notifications, pipelines, profiles, schedules, system, tasks, ws

    app.include_router(system.router)
    app.include_router(tasks.router)
    app.include_router(approvals.router)
    app.include_router(dreams.router)
    app.include_router(memory.router)
    app.include_router(notifications.router)
    app.include_router(pipelines.router)
    app.include_router(profiles.router)
    app.include_router(schedules.router)
    app.include_router(ws.router)

    if FRONTEND_DIST.exists():
        app.mount("/", SPAStaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
    return app


class SPAStaticFiles(StaticFiles):
    """Serve the built frontend with SPA fallback to index.html."""

    async def get_response(self, path: str, scope):
        from starlette.exceptions import HTTPException as StarletteHTTPException

        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code == 404:
                return await super().get_response("index.html", scope)
            raise


app = create_app()
