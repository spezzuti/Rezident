# Agent home directories

The third ADE adoption (see docs/agent-memory.md for the first two). Memory v2
gave personas continuity of *knowledge*; homes give them continuity of *work
product* — a durable per-agent workspace that survives across tasks and
sessions. Status: **specced and implemented 2026-07-08**. Decisions locked with
the operator: home is the default cwd; delete-with-confirm; file listing in v1.

## Layout

```
data\homes\<profile_id>\      one home per LOCAL persona, created lazily
data\homes\<profile_id>\.git  per-home git fence (same trick as data\scratch)
```

- Sibling of `worktrees\` and `scratch\`, so it is covered automatically by
  backups, the uninstaller's keep-or-delete prompt, and the AgentOS→Rezident
  data migration.
- Keyed by profile **id** (stable across renames), never by name.
- The fence is **per home**: Claude Code resolves the project root by walking
  up to the nearest `.git`, so each persona sees its own home as the project —
  and cannot wander sideways into a sibling's home (a single fence at
  `homes\` would make every home one shared project).
- Local personas only. Bridged runtimes (ACP/CLI/HTTP) have no local file
  access; their home is their own machine.

## Behaviour

**Default cwd** (`runner._effective_cwd`), in priority order:

1. `worktree_path` — repo tasks keep their isolated worktree (correctness
   beats coziness; the home must never receive stray repo edits)
2. explicit task `cwd`
3. **the resolved profile's home** ← new
4. `data\scratch` — fallback when no profile resolves (shouldn't happen for
   local runs; kept as a safety net)

**The agent is told**: `_build_options` appends a short system-prompt section —
your home directory is X, it persists across sessions, keep notes/scripts/
working files there; durable *facts* still go to the memory write-back
protocol. The section is appended for every local run (including repo tasks,
where cwd stays the worktree but the agent may consult its notes).

**Creation is lazy**: `ensure_home` runs mkdir + `git init -q` only when the
`.git` fence is missing; no git on the machine degrades to an unfenced dir
(same graceful degradation as the scratch fence).

**Delete**: removing a companion deletes its home. Both UIs say so in the
confirm (with the live file count) before the click. `DELETE /api/profiles/…`
does the rmtree after the DB row goes.

## API

- `GET /api/profiles` — each row gains `home: {exists, files, bytes}`
  (bounded directory walk, `.git` excluded).
- `GET /api/profiles/{id}/home` — full listing:
  `{path, files: [{path, size, mtime}], count, bytes, truncated}` — newest
  first, capped at 200 entries, `.git` excluded. 404 for unknown profiles;
  an empty shape (`exists: false`) for personas that have not written yet.
- `GET /api/profiles/{id}/home/file?path=…` — inline preview: UTF-8 text
  capped at 200 KB, binaries flagged (`binary: true, content: null`). Every
  path goes through `homes.resolve_file`, which refuses traversal (`..`,
  absolute paths, symlink hops) and `.git` with a 400.
- `GET /api/profiles/{id}/home/download?path=…` — raw `FileResponse` for any
  file/size, same path guard.
- `DELETE /api/profiles/{id}` — deletes the home after the row; response
  carries `home_deleted`.

### Size budget

`AGENTOS_HOME_SIZE_BUDGET_MB` (default 200, 0 disables) is a soft, advisory
cap: `home_stats` sets `over_budget`, both UIs badge it (⚠ on the PIP folder
and drawer, `⚠ OVER BUDGET` in the cyber homeLabel), and the dreams digest
flags it. Nothing is ever deleted automatically.

### Dreams

`_build_digest` includes an "Agent home directories" section — per-persona
file count, size, budget flag, and the three newest paths — so dreams can
notice abandoned work and propose cleanups.

## UI (both themes — parity rule)

- **PIP-OS Companions** (Skills.tsx): each personnel folder gets a HOME
  drawer — file count + size on the folder, expandable newest-first file
  listing fetched on open, per-file inline preview (click the name) and
  download (⬇, fetch → blob → anchor).
- **GRID//OS CREW**: dossier shows the same stats; on-demand `crew-home`,
  `crew-home-file` (preview) and `crew-home-download` actions relay through
  the host (`agentos:crew-home*` reply channels, same pattern as
  `task-diff`). Downloads run in the top window — the deck iframe never
  touches the token.
- Delete confirms in both themes name the home and its file count.
