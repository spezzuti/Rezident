# Packaging Rezident as a Windows desktop app

Rezident ships in two modes from one codebase, switched by `agentos/paths.py::is_desktop()`:

| | **dev** (run from repo) | **desktop** (packaged `.exe`, or `AGENTOS_DESKTOP=1`) |
|---|---|---|
| Bind | `0.0.0.0:8734` (LAN / phone / Tailscale) | `127.0.0.1` + auto port fallback (no firewall prompt) |
| Config | `backend/.env` | env vars only |
| Token | `AGENTOS_TOKEN` from `.env` | generated once, persisted to `…\Rezident\data\token` |
| Data | `<repo>\data` | `%LOCALAPPDATA%\Rezident\data` |
| SPA assets | `<repo>\frontend\dist` | unpacked under `sys._MEIPASS` |

The packaged app is a per-user program (never a Windows Service). It starts the
existing FastAPI/uvicorn process in a background thread and opens a native
**WebView2** window at `http://127.0.0.1:<port>/?token=<token>`; the frontend
reads that `?token=` param into `localStorage` and auto-logs the local user in.

## What stays on the target machine (not bundled)

Rezident drives whatever agent runtimes are already installed — it detects them,
it does not ship them:

- **Claude Code CLI** — installed **and** signed in (`claude` then `/login`;
  the subscription OAuth lives in `%USERPROFILE%\.claude`). The app spawns it;
  the ~230 MB bundled `claude.exe` inside the SDK is deliberately dropped.
- **Git for Windows** — `git.exe` (repo tasks + scratch fencing) and `bash.exe`
  (verify commands run `bash.exe -lc`). Missing git degrades gracefully now
  (boot no longer crashes) but repo tasks/verify need it.
- **Edge WebView2 runtime** — the window's renderer. Preinstalled on Windows 11;
  the installer can chain its bootstrapper for Win10/LTSC/Server. Without it the
  app opens in your **default browser** instead (with a tray icon to quit).

`GET /api/readiness` (unauthenticated) reports all of the above; the desktop
shell shows a warning if a **required** dependency is missing before opening.

## Build host setup

```sh
# 1) Frontend — MANDATORY rebuild (bakes in the ?token= auto-login shim)
cd frontend && npm ci && npm run build && cd ..

# 2) Desktop build deps into the backend venv
backend/.venv/Scripts/python.exe -m pip install -r backend/requirements-desktop.txt

# 3) (optional) regenerate the app icon
backend/.venv/Scripts/python.exe packaging/make_icon.py
```

## Build the exe

```sh
# from the repo root, with the backend venv's pyinstaller
backend/.venv/Scripts/pyinstaller.exe Rezident.spec --noconfirm
#  -> dist/Rezident/Rezident.exe  (+ dist/Rezident/_internal/)
```

onedir (not onefile) is the default: fast cold start, each file is
Authenticode-signable, and far less likely to trip Defender/SmartScreen.

> **onedir gotcha:** `Rezident.exe` and the `_internal\` folder next to it are ONE
> unit. Do **not** copy the `.exe` out on its own — the bootloader loads
> `_internal\python311.dll`, so a lone exe fails with *"Failed to load Python DLL
> python311.dll."* Keep the whole `dist\Rezident\` folder together, or install via
> the `.iss` installer.

### Single-file build (portable)

For a single `.exe` you can copy anywhere and double-click (no `_internal\`
folder to keep alongside), build onefile:

```sh
AGENTOS_ONEFILE=1 backend/.venv/Scripts/pyinstaller.exe Rezident.spec \
    --noconfirm --distpath dist/onefile --workpath build/onefile
#  -> dist/onefile/Rezident.exe   (one self-contained file)
```

Trade-offs: it self-extracts to `%TEMP%` on each launch (slower cold start) and
is more likely to trip SmartScreen. Data still lives in `%LOCALAPPDATA%\Rezident`,
so it's stateful across runs and machines the same way.

## Build the installer (optional)

Requires [Inno Setup](https://jrsoftware.org/isinfo.php) (`iscc`):

```sh
# optionally drop MicrosoftEdgeWebview2Setup.exe next to the .iss to chain it
iscc packaging/Rezident.iss     # -> packaging/Output/Rezident-Setup.exe
```

Per-user install to `%LOCALAPPDATA%\Programs\Rezident`, Start Menu + optional
Desktop/Startup shortcuts, WebView2 chaining when absent, and an uninstaller
that stops the app and offers to keep or delete your data.

## Headless verification (no GUI / CI)

The identical desktop code path runs server-only with `AGENTOS_HEADLESS=1`, so
it is curl-verifiable without a display — from source **or** from the frozen exe:

```sh
# from source (desktop mode)
AGENTOS_HEADLESS=1 backend/.venv/Scripts/python.exe backend/desktop/app.py &
# or from the frozen build
AGENTOS_HEADLESS=1 dist/Rezident/Rezident.exe &

TOK=$(cat "$LOCALAPPDATA/Rezident/data/token")
curl -s  http://127.0.0.1:8734/api/health                       # {"status":"ok",...}
curl -s  http://127.0.0.1:8734/api/readiness                    # dependency checklist (no auth)
curl -sI http://127.0.0.1:8734/                                 # 200 + index.html (SPA)
curl -s  http://127.0.0.1:8734/tasks | grep -q 'id="root"'      # SPA deep-link fallback
curl -s -o /dev/null -w '%{http_code}\n' \
     -H "Authorization: Bearer $TOK" \
     http://127.0.0.1:8734/api/system/environment               # 200 (401 without the token)
# subprocess smoke — env scan spawns `claude --version`/`git --version` in-thread:
curl -s -H "Authorization: Bearer $TOK" \
     "http://127.0.0.1:8734/api/system/environment?force=true"  # agents[] show real versions
```

`python -m agentos` is the dev-parity headless server (no window, `<repo>\data`,
fixed 8734), and doubles as the desktop shell's child-process fallback.

## Boot-level autostart (optional, opt-in)

System page → **Autostart** → INSTALL BOOT SERVICE (also in GRID//OS Settings →
System). Registers a Windows Scheduled Task (`Rezident Service`, boot trigger,
S4U logon) that runs `Rezident.exe --service --host <bind>` at machine startup,
**before login**, as the installing user — so the Claude CLI auth in
`~/.claude`, git identity, and PATH probing all still work (a SYSTEM service
would not have them). Nothing installs this by default; install/remove each
raise one Windows admin (UAC) prompt on the machine, and REMOVE cleanly stops
and deregisters it.

- Bind choice at install: `0.0.0.0` (LAN/Tailscale — the phone-access case) or
  `127.0.0.1` (this PC only). Token auth gates every request either way.
- Both entry points (`--service` and `python -m agentos`) probe `runtime.json`
  + `/api/health` first and exit if a live instance answers, so the service and
  a manual launch can never double-serve the shared database.
- Double-clicking `Rezident.exe` while the service runs **attaches**: it opens
  its window against the running service instead of starting a second server.

## Data & secrets location (desktop mode)

`%LOCALAPPDATA%\Rezident\data\`:

- `agentos.db` (+ `-wal`/`-shm`) — SQLite state
- `token` — the single-user API token (generated once)
- `runtime.json` — `{url,host,port,pid}` of the running instance (no secret)
- `worktrees\`, `scratch\.git\` — per-task git workspaces
- `logs\agentos.log` — stdout/stderr when launched windowed (no console); first
  place to look if the app opens then vanishes

Rename note: installs from the AgentOS era are migrated automatically — on
first boot the app moves `%LOCALAPPDATA%\AgentOS\data` into
`%LOCALAPPDATA%\Rezident\data` (db, token, worktrees intact). Internal
identifiers (`agentos` package, `AGENTOS_*` env vars, `agentos.db`) keep their
original names on purpose.

## Auth & trust model

Single local user. The generated token gates every REST call (Bearer) and the
WebSocket (`?token=` query param). Loopback bind means nothing is exposed off
the machine; set `AGENTOS_HOST=0.0.0.0` to re-enable LAN/Tailscale access.

## Cutting a release (self-update depends on this)

The desktop app self-updates by reading GitHub Releases (`spezzuti/Rezident`),
downloading the flavor-matched asset, and verifying it against a published
`SHA256SUMS`. The exact asset names and the checksum file are a contract with
`agentos/update.py` — follow this sequence:

```sh
# 1) Bump every version copy in lockstep (semantic source of truth is
#    agentos.__version__; also rewrites pyproject, version_info.txt, Rezident.iss)
backend/.venv/Scripts/python.exe backend/scripts/bump_version.py X.Y.Z

# 2) Build all three artifacts (see sections above)
cd frontend && npm ci && npm run build && cd ..
backend/.venv/Scripts/pyinstaller.exe Rezident.spec --noconfirm                 # onedir
AGENTOS_ONEFILE=1 backend/.venv/Scripts/pyinstaller.exe Rezident.spec \
    --noconfirm --distpath dist/onefile --workpath build/onefile                 # onefile portable
iscc packaging/Rezident.iss                                                      # installer

# 3) Gather the two shipped exes under one dir and hash BOTH into SHA256SUMS.
#    Portable copy = dist/onefile/Rezident.exe ; installer = packaging/Output/Rezident-Setup.exe
sha256sum Rezident.exe Rezident-Setup.exe > SHA256SUMS   # filenames must be bare, no paths

# 4) Tag and publish — the tag name is the version the app compares against
git tag vX.Y.Z
gh release create vX.Y.Z Rezident.exe Rezident-Setup.exe SHA256SUMS \
    --title "Rezident vX.Y.Z" --notes "…"
```

Asset-name contract (`update.py` resolves by exact name):

- **`Rezident.exe`** — the portable single-file build (self-update replaces the
  running exe in place via a detached swap helper).
- **`Rezident-Setup.exe`** — the Inno installer (self-update runs it
  `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART`, then relaunches from InstallLocation).
- **`SHA256SUMS`** — `sha256  <filename>` lines for both exes; a mismatch aborts
  the install and discards the download.

**RULE: never re-upload assets under an existing tag.** A published tag is
immutable — clients cache its `tag_name` and asset URLs. To fix a bad build,
bump to a new patch version and cut a fresh tag; deleting/replacing assets on a
live tag would hand already-updated users a checksum that no longer matches.

Local end-to-end test without touching the public repo: point
`AGENTOS_UPDATE_API_BASE` at a mock server that serves `releases/latest` + the
assets + `SHA256SUMS` (this is exactly what `backend/tests/test_update.py` does).

## Troubleshooting

- **SmartScreen on first run** — unsigned exe: *More info → Run anyway*, or
  Authenticode-sign `Rezident.exe` (onedir keeps each file signable).
- **Blank window** — WebView2 runtime missing; the app falls back to the browser
  + tray. Install the Evergreen runtime.
- **Port 8734 busy** — the app auto-rebinds to an ephemeral port (see
  `runtime.json`).
- **Launched twice** — a second launch detects the first (per-user mutex) and
  reopens the running instance instead of starting a duplicate server, so the
  startup shortcut + a manual double-click can't fork the shared database.
- **Tasks fail immediately** — `claude` not found or not signed in; run
  `claude` + `/login`, then hit *Re-check* / reopen. `/api/readiness` shows the
  exact resolved path.
- **Verify commands fail** — Git for Windows (`bash.exe`) not installed.
