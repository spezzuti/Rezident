# Agent memory v2 — per-agent curated memory + memory for bridged runtimes

Two features adopted from ADE (per-simmons/damon-ade, itself adapted from the
Hermes agent — the same lineage as our Dreaming module). Status: **specced,
implemented 2026-07-08**.

## Feature A — every runtime shares the operator memory

**Today:** `memory.render_block()` (top-50 enabled facts) is injected only on
the local Claude SDK path (`runner._build_options`). Bridged runtimes —
OpenAI-compatible HTTP, Hermes CLI, ACP, Codex/stdin CLIs — receive nothing:
redacted doesn't know what the operator saved.

**Design:** inject the same block at the runner level for every integration
flow, carried as an OpenAI-style `{"role": "system"}` message so one mechanism
covers all transports:

| Path | Injection |
|---|---|
| `runner._run_integration` (one-shot deploy/pipeline) | switch `dispatch(key, prompt)` → `dispatch_messages(key, [system, user])` |
| `runner._run_integration_chat` (Comms, openai transport) | `history` starts `[system, user…]`; history is re-sent per turn so it persists |
| `runner._run_acp_chat` (Comms, ACP) | prepend block to the **first** prompt text — the persistent ACP session carries it natively |
| CLI/stdin/codex + one-shot ACP transports | `_flatten_for_cli` currently **drops** system messages; it now renders them as a `[Context from your operator]` preamble above the transcript |

**Deliberately not injected:** the raw `POST /api/integrations/{key}/dispatch`
and `/chat` endpoints (config tester + legacy direct path). The tester must
stay deterministic — mock-echo verification depends on it — and task-based
flows all pass through the runner anyway.

No per-integration opt-out in v1 (profiles keep their `inject_memory` flag;
integrations always get the block). Add a slot toggle later if a runtime
chokes on it.

## Feature B — per-agent memory with agent write-back

**Today:** one global `memory_facts` pool, written only by the operator via
the UI, injected identically into every agent. Personas are static configs —
they never learn. Dreaming closes the loop only globally and periodically.

**Goal (ADE's "durable identity"):** each agent gets its own memory lane; the
agent itself writes to it mid-session under a write-back protocol; the
operator sees and curates everything.

### Identity key

`memory_facts.agent_key TEXT` (migration v12, nullable):

- `NULL` — operator/global fact (today's rows unchanged)
- `profile:<profile_id>` — a local Claude persona (Securitron, Curie, …)
- `integration:<key>` — a bridged runtime (redacted, …)

Runner resolves the key per task: `integration:<integration_key>` when set,
else `profile:<profile_id or the default profile>`.

### Injection

`render_block(agent_key)` now renders up to three sections:

1. `# Operator memory` — global facts (cap 50, unchanged)
2. `# Your memory` — the agent's own facts (cap 30, only when agent_key)
3. The **write-back protocol** (only when agent_key):

> To remember something durable — a correction, a stated preference, a fact
> that will matter next session — end a reply with:
>
> ````
> ```agentos-memory
> {"remember": ["<one concise fact>"], "forget": ["<exact text of one of your facts>"]}
> ```
> ````
>
> Durable facts only; never session trivia or things the operator can see
> themselves. Before finishing a task, consider whether anything durable was
> learned.

**Why an in-band text protocol** (vs a tool or API call): it needs no tool
permissions, no token in the agent's environment, and — decisive — it works
identically for **remote** runtimes like redacted, which have no AgentOS tools
at all. Same pattern as Dreaming's trailing ```json actions block.

### Write-back handling

`memory.extract_writeback(text) -> (clean_text, remember[], forget[])` parses
and strips the fenced block (regex, mirrors `dreams._extract_actions`;
malformed JSON → treated as absent, block still stripped).
`memory.apply_writeback(agent_key, remember, forget)`:

- `remember`: INSERT with `source='agent'`, the agent's key; ≤5 per message,
  ≤500 chars each, exact-duplicate content for the same agent skipped
- `forget`: matches **the agent's own** facts by exact content → sets
  `enabled=0` (disable, never delete — the operator can review/undelete)

Hook points (reply text is cleaned before display/persistence everywhere):

- local Claude: `_on_assistant` TextBlock → extract, apply, emit
  `memory_write` event + clean `assistant_text`; `run()` strips the block
  from `result_summary` (no re-apply — dedupe makes it idempotent anyway)
- `_run_integration_chat`, `_run_acp_chat`, `_run_integration`: same
  extract/apply/clean on each reply

New task event `memory_write` payload:
`{agent_key, remember: [{id, content}], forget: [content…]}`.

### Reflection

ADE runs a dedicated session-end reflection turn. Our chats end via
cancel/interrupt (no safe extra turn) and an extra turn costs a real model
call, so v1 folds reflection into the protocol text ("before finishing…").
An explicit END SESSION reflection turn is future work.

### API

- `GET /api/memory/facts?agent_key=…` filter (list output already carries the
  column via `SELECT *`)
- `FactCreate.agent_key` optional — the operator can hand a fact to a
  specific agent from the UI

### UI — both themes (parity constraint)

- **PIP-OS** Memory.tsx: owner badge per fact (agent icon + name from
  `/api/agents`; no badge = OVERSEER/global). Chat.tsx: render `memory_write`
  as a phosphor line — `◈ MEMORY COMMITTED — <fact>`.
- **GRID//OS**: `cyberBridge.mapMemories` gains an owner chip on facts;
  `mapTaskEvents` renders `memory_write` as a `◈ MEMORY WRITE` line in the
  task-detail stream.
- Dreams digest: facts render with their owner tag so dreams reason over
  per-agent memory too.

### Verification

1. `extract_writeback` unit pass (present / absent / malformed / multi).
2. Local E2E: chat with a persona, tell it a durable preference, confirm the
   `memory_write` event, the `source='agent'` fact row, the stripped reply —
   then a **fresh** chat with the same persona recalls it (and a different
   persona does not see it in its "Your memory" section).
3. Bridged E2E: mock OpenAI server captures the request body — first message
   is `role:system` containing "Operator memory" (message count grows by 1).
4. UI: fact badges visible in both themes; memory_write line renders in Comms.

### Cost & risk

- Prompt growth: ≤30 short agent facts + protocol text (~300 tokens) per
  session — negligible against a chat session's baseline.
- A chatty agent spamming remembers: capped at 5/message + dedupe; worst case
  the operator disables facts in the UI (they own the pool).
- The block leaking into display: every surface renders the *cleaned* text;
  raw text never reaches events.
