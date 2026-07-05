# AgentOS

A self-hosted web dashboard that operates a Claude Code agent system. The UI is the OS:
launch tasks, watch agents stream live, approve dangerous actions, and never let a task
reach **done** without passing its verification command.

## Views

- **Mission Control** — live agent cards (pulsing status, activity, elapsed, cost), animated stat tiles for cost/tokens today
- **Task Board** — kanban: Queued → Running → Verifying → Done / Failed; cards glow while live
- **Task Detail** — streaming message log (text, thinking, collapsible tool calls), Diff tab for repo tasks, follow-up messages, Cancel / Retry / Merge / Discard
- **Approvals** — dangerous tool calls pause the agent until you approve (optionally after editing the command), deny with a reason the agent hears, or "always allow" to mint a rule; badge count everywhere, works from a phone
- **Memory** — durable facts injected into every agent's system prompt (searchable, inline edit, toggle), plus an episode history of every run
- **Skills & Tools** — agent profiles (blocked tools, auto-approved tools, permission mode, model, per-profile prompt) and the approval-rules table
- **Scheduler** — cron-style recurring agents with run-now and overlap policy

## Stack

- **Backend**: FastAPI + `claude-agent-sdk` (one `ClaudeSDKClient` per task) + SQLite (WAL) + WebSocket
- **Frontend**: React + Vite + TypeScript + Tailwind + zustand
- **Runner**: native Windows, using your existing Claude subscription login

## Run

```powershell
# backend (serves the built frontend at the same port)
cd backend
.\.venv\Scripts\uvicorn.exe agentos.main:app --host 0.0.0.0 --port 8734

# frontend dev mode (optional, proxies /api and /ws to :8734)
cd frontend
npm run dev
```

Open http://localhost:8734 and paste the token from `backend/.env` (`AGENTOS_TOKEN=…`).

**From your phone**: with the backend bound to 0.0.0.0, browse to `http://<this-pc's-LAN-or-Tailscale-IP>:8734`, log in with the same token, and approve agent actions from anywhere. The UI collapses to a bottom tab bar on small screens. If the phone can't reach it, allow python.exe through Windows Firewall on private networks. Prefer Tailscale over plain LAN when away from home — the token rides a query string on the WebSocket, so the encrypted transport matters.

## First-time setup

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\pip install -e .
python -c "import secrets; print('AGENTOS_TOKEN=' + secrets.token_urlsafe(32))" > .env
cd ..\frontend
npm install && npm run build
```

Requires: Python 3.11+, Node 20+, Git for Windows, an authenticated `claude` CLI.

## Architecture notes

- **Task lifecycle**: `queued → running → (awaiting_approval | waiting_input)* → verifying → done|failed`, plus `cancelled`. All transitions are validated in `task_manager.py` and every one is a persisted `status_change` event.
- **Events are persist-first**: each event is written to `task_events` with a per-task monotonic `seq`, then fanned out over WebSocket. Reconnecting clients replay `after_seq` — no gaps.
- **Approvals** (`approvals.py`): `can_use_tool` pauses the agent mid-tool-call; a rules engine auto-allows/denies known patterns and queues the rest for human sign-off (asyncio.Future per approval).
- **Verification**: verify commands run via Git Bash (`bash.exe -lc`) in the task cwd; exit 0 is the only path to `done`.
- **Scratch fence**: `data/scratch` is its own git repo so agents there don't walk up and treat AgentOS's repo as their project.
- **Smoke test**: `backend/scripts/sdk_smoke.py` — run after every `claude-agent-sdk` or CLI upgrade. Note: read-only Bash (echo, ls…) is auto-approved by Claude Code itself and never reaches the approval gate; only mutating calls do.
