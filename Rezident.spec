# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the Rezident desktop app (onedir).

Build from the repo root with the backend venv active:
    backend/.venv/Scripts/pyinstaller.exe Rezident.spec --noconfirm
-> dist/Rezident/Rezident.exe (+ _internal/)

onedir (not onefile): fast cold start (no per-launch self-extraction), each
file is Authenticode-signable, and it trips Defender/SmartScreen far less. The
read-only install dir is fine because all writes go to %LOCALAPPDATA%\\Rezident.
"""

import os

from PyInstaller.utils.hooks import collect_all, collect_submodules

REPO = os.path.abspath(os.getcwd())

datas, binaries, hiddenimports = [], [], []

# The prebuilt SPA that agentos.main serves at '/'. MUST be rebuilt first
# (npm run build) so it contains the ?token= auto-login shim.
datas += [(os.path.join("frontend", "dist"), os.path.join("frontend", "dist"))]

# Packages with runtime string-imports / package data / compiled extensions.
for pkg in (
    "fastapi", "starlette", "pydantic", "pydantic_settings", "pydantic_core",
    "anyio", "uvicorn", "websockets", "aiosqlite", "croniter",
    "httpx", "httpcore",  # integrations.py bridges to runtimes over HTTP
    "claude_agent_sdk", "webview", "clr_loader",
):
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception as exc:  # a missing optional (e.g. webview in a server-only venv) shouldn't break the build
        print(f"[spec] collect_all({pkg!r}) skipped: {exc}")

# Our own package: pull every submodule so lazy imports (api.*, scheduler,
# environment, dreams, orchestrator) survive PyInstaller's static analysis.
hiddenimports += collect_submodules("agentos")

# uvicorn[standard] selects its loop + protocol implementations by string at runtime.
hiddenimports += [
    "uvicorn.loops.auto", "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.auto", "uvicorn.protocols.http.h11_impl", "uvicorn.protocols.http.httptools_impl",
    "uvicorn.protocols.websockets.auto", "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.lifespan.on", "uvicorn.lifespan.off",
    "h11", "httptools", "websockets.legacy",
]

# Drop the SDK's ~230 MB bundled claude.exe — the target machine supplies AND
# authenticates its own claude; bundling it bloats the installer and could shadow
# the user's authenticated CLI.
_norm = lambda p: str(p).replace("\\", "/")
datas = [(s, d) for (s, d) in datas if "_bundled" not in _norm(s)]
binaries = [(s, d) for (s, d) in binaries if os.path.basename(str(s)).lower() != "claude.exe"]

_icon = os.path.join("backend", "desktop", "assets", "agentos.ico")
icon = _icon if os.path.exists(_icon) else None
_verfile = os.path.join("packaging", "version_info.txt")
version = _verfile if os.path.exists(_verfile) else None

a = Analysis(
    [os.path.join("backend", "desktop", "app.py")],
    pathex=[os.path.join(REPO, "backend")],   # so `import agentos` resolves
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    excludes=["uvloop", "watchfiles", "tkinter", "pytest", "PyQt5", "PyQt6", "PySide2", "PySide6"],
    noarchive=False,
)
pyz = PYZ(a.pure)

# AGENTOS_ONEFILE=1 -> a single self-contained Rezident.exe (dist/Rezident.exe) you
# can copy anywhere and double-click; it self-extracts to %TEMP% at launch (slower
# cold start). Default -> onedir (dist/Rezident/ — faster, but the exe MUST stay
# next to its _internal/ folder). The installer wraps the onedir tree.
ONEFILE = os.environ.get("AGENTOS_ONEFILE") == "1"

if ONEFILE:
    exe = EXE(
        pyz,
        a.scripts,
        a.binaries,
        a.datas,
        [],
        name="Rezident",
        console=False,
        icon=icon,
        version=version,
    )
else:
    exe = EXE(
        pyz,
        a.scripts,
        [],
        exclude_binaries=True,          # onedir
        name="Rezident",
        console=False,                  # GUI app (no console window)
        icon=icon,
        version=version,
    )
    coll = COLLECT(
        exe,
        a.binaries,
        a.datas,
        strip=False,
        upx=False,
        name="Rezident",
    )
