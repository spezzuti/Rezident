/**
 * Maps real AgenticOS data into the shapes GRID//OS's DCLogic expects, so the
 * Cyber theme's Board and Auth apps render live tasks and approvals.
 */
import { ACTIVE_STATUSES, type Task, type TaskEvent, type TaskStatus } from '../lib/types'

export interface HostApproval {
  id: string
  task_id: string
  task_title?: string
  tool_name: string
  tool_input: Record<string, any>
  created_at: string
}

// AgenticOS status -> GRID//OS kanban lane (queued/running/review/done/failed)
const LANE_OF: Record<TaskStatus, string> = {
  queued: 'queued',
  running: 'running', awaiting_approval: 'running', waiting_input: 'running',
  verifying: 'review',
  done: 'done', failed: 'failed', cancelled: 'failed',
}
// priority tint: hi=red, md=amber, lo=cyan
const PRI_OF: Record<TaskStatus, 'hi' | 'md' | 'lo'> = {
  queued: 'lo', running: 'md', awaiting_approval: 'hi', waiting_input: 'hi',
  verifying: 'md', done: 'lo', failed: 'hi', cancelled: 'md',
}

export function mapBoard(tasks: Record<string, Task>) {
  const lanes: Record<string, any[]> = { queued: [], running: [], review: [], done: [], failed: [] }
  const all = Object.values(tasks).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
  for (const t of all) {
    const lane = LANE_OF[t.status] ?? 'done'
    lanes[lane].push({
      id: t.id,
      title: t.title || '(untitled)',
      agent: t.agent_name || 'operator',
      icon: t.agent_icon || '',
      pri: PRI_OF[t.status] ?? 'lo',
      status: t.status,
      cost: t.total_cost_usd ?? 0,
      canCancel: ACTIVE_STATUSES.includes(t.status),
      canRetry: t.status === 'failed' || t.status === 'cancelled',
    })
  }
  lanes.done = lanes.done.slice(0, 40)
  lanes.failed = lanes.failed.slice(0, 40)
  return lanes
}

export interface HostStats {
  tasks_by_status: Record<string, number>
  cost_today_usd: number
  cost_week_usd: number
  tokens_today: { input: number; output: number }
}

// Mission-Control-equivalent telemetry for GRID//OS: cost meters + live task counts.
export function mapStats(stats: HostStats | null, tasks: Record<string, Task>) {
  const by = stats?.tasks_by_status || {}
  const active = Object.values(tasks).filter((t) => ACTIVE_STATUSES.includes(t.status))
  const liveBurn = active.reduce((s, t) => s + (t.total_cost_usd || 0), 0)
  const tk = stats?.tokens_today || { input: 0, output: 0 }
  return {
    liveBurn,
    costToday: stats?.cost_today_usd || 0,
    costWeek: stats?.cost_week_usd || 0,
    tokensToday: (tk.input || 0) + (tk.output || 0),
    running: (by.running || 0) + (by.awaiting_approval || 0) + (by.waiting_input || 0) + (by.verifying || 0),
    done: by.done || 0,
    failed: (by.failed || 0) + (by.cancelled || 0),
  }
}

const CRIT = /(rm\s+-rf|mkfs|dd\s|shutdown|reboot|:\(\)\s*\{|>\s*\/dev\/|\bformat\b|drop\s+table|--force|git\s+push\s+--force)/i
function riskOf(a: HostApproval): 'low' | 'med' | 'high' | 'crit' {
  const cmd = `${typeof a.tool_input?.command === 'string' ? a.tool_input.command : ''} ${a.tool_input?.file_path ?? ''}`
  if (CRIT.test(cmd)) return 'crit'
  const tool = a.tool_name.toLowerCase()
  if (tool === 'bash') return 'high'
  if (tool === 'write' || tool === 'edit' || tool === 'notebookedit' || tool === 'multiedit') return 'high'
  if (tool === 'read' || tool === 'glob' || tool === 'grep' || tool === 'webfetch') return 'low'
  return 'med'
}
function detailOf(a: HostApproval): string {
  const ti = a.tool_input || {}
  if (typeof ti.command === 'string') return ti.command
  if (typeof ti.file_path === 'string') {
    return ti.file_path + (typeof ti.content === 'string' ? ` — ${ti.content.slice(0, 120)}` : '')
  }
  const s = JSON.stringify(ti)
  return s.length > 200 ? s.slice(0, 200) + '…' : s
}
function relTime(iso: string): string {
  const t = new Date(iso.endsWith('Z') ? iso : iso + 'Z').getTime()
  const d = Math.max(0, Date.now() - t)
  const m = Math.floor(d / 60000)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}h ago`
  if (m > 0) return `${m}m ago`
  return `${Math.floor(d / 1000)}s ago`
}

export interface HostFact {
  id: string
  content: string
  tags: string
  source: string
  enabled: number
  updated_at: string
}

// memory facts don't carry a category; infer one so the deck's semantic/episodic/procedural filter is useful
function catOf(f: HostFact): 'semantic' | 'episodic' | 'procedural' {
  const s = `${f.source} ${f.tags}`.toLowerCase()
  if (/epis|session|run\b|task|outcome|episode/.test(s)) return 'episodic'
  if (/proc|how-?to|rule|step|workflow|command|recipe/.test(s)) return 'procedural'
  return 'semantic'
}

export interface HostEpisode {
  id: string
  task_id: string
  title: string
  summary: string | null
  outcome: string
  cost_usd: number
  created_at: string
}

// GRID//OS "MEMORY BANK" shows BOTH facts and auto-logged episodes, same as PIP-OS
// Holotapes. Facts are forgettable; episodes are read-only run history (kind:'episode').
export function mapMemories(list: HostFact[], episodes: HostEpisode[] = []) {
  const facts = list.map((f) => {
    const content = f.content || ''
    const nl = content.indexOf('\n')
    const title = ((nl > 0 ? content.slice(0, nl) : content).slice(0, 64).trim()) || '(memory)'
    const tags = (f.tags || '').split(/[,\s]+/).map((t) => t.trim()).filter(Boolean).slice(0, 6)
    return {
      id: f.id,
      kind: 'fact' as 'fact' | 'episode',
      title,
      body: content,
      cat: catOf(f),
      tags,
      src: f.source || 'system',
      imp: f.enabled ? 2 : 1,
      pinned: false,
      ts: relTime(f.updated_at),
    }
  })
  const eps = episodes.map((e) => ({
    id: 'ep:' + e.id,
    kind: 'episode' as 'fact' | 'episode',
    title: (e.title || '(episode)').slice(0, 64),
    body: e.summary || e.outcome || '',
    cat: 'episodic' as 'semantic' | 'episodic' | 'procedural',
    tags: [e.outcome].filter(Boolean).slice(0, 6),
    src: 'episode',
    imp: 2,
    pinned: false,
    ts: relTime(e.created_at),
  }))
  return [...facts, ...eps]
}

export interface HostProfile {
  id: string
  name: string
  description?: string | null
  system_prompt_append?: string | null
  permission_mode?: string
  model?: string | null
  is_default?: number | boolean
  role?: string | null
  icon?: string
  color?: string
  inject_memory?: number | boolean
  allowed_tools?: string[]
  disallowed_tools?: string[]
  max_turns?: number | null
}

const TRUST_PM: Record<string, number> = { bypassPermissions: 96, acceptEdits: 86, default: 74, plan: 58 }

// cyberpunk street handles for the deck's Crew roster — the PIP-OS profile name
// stays in the dossier. Known Fallout defaults get hand-picked aliases; anything
// else falls back to a leet-ified version of its own name.
const HANDLE_ALIAS: Record<string, string> = {
  securitron: 'BLACKICE',
  eyebot: 'WIRETAP',
  'mister handy': 'FIXER',
  curie: 'H3LIX',
  'liberty prime': '0VERL0RD',
}
function crewHandle(name: string): string {
  const alias = HANDLE_ALIAS[name.toLowerCase()]
  if (alias) return alias
  return (name || 'agent').replace(/o/gi, '0').replace(/\s+/g, '_').toUpperCase().slice(0, 12)
}

// deck-themed rewrites of the crew dossiers (PIP-OS profiles are Fallout-flavored),
// keyed by profile name; unknown profiles keep their own role/description.
const CREW_DOSSIER: Record<string, { role: string; bio: string }> = {
  securitron: {
    role: 'ICE-hardened operator · asks before it cuts',
    bio: "Default runtime on the grid: balanced, methodical, paranoid by design. Routes every risky call past the operator before it touches anything live. When you don't know who to send, send BLACKICE.",
  },
  eyebot: {
    role: 'Signals recon · reads all, touches nothing',
    bio: 'A ghost on the wire. Crawls, greps and taps the datastream but never writes a byte - pure surveillance. Point it at a target; it comes back with everything and a trace of nothing.',
  },
  'mister handy': {
    role: 'Street fixer · fast, cheap, always on',
    bio: 'The one you call for grunt work: scheduled jobs, quick fetches, cleanup runs. Runs the cheap fast model so you can burn it all shift without bleeding credits.',
  },
  curie: {
    role: 'Deep analyst · pulls signal from noise',
    bio: 'Turns raw data into intel. Reads deep, cross-references and reasons through the hard problems on the balanced model - analysis only, never touches the deployment rails.',
  },
  'liberty prime': {
    role: 'Heavy iron · complex builds only',
    bio: 'Wheeled out for the big jobs: complex engineering, multi-stage builds, the work nothing else can carry. Runs the premium model - overpowered, and worth it when the job is real.',
  },
}

// AgenticOS agent profiles (+ enabled integrations) -> GRID//OS crew members.
// Local Claude personas and remote runtimes (Hermes/OpenClaw/…) share one roster.
export function mapCrew(list: HostProfile[], integrations: HostIntegration[] = []) {
  const cycle = ['online', 'idle', 'online', 'online', 'idle']
  const crew = list.map((p, i) => {
    const model = p.model || 'inherit'
    const pm = p.permission_mode || 'default'
    const name = p.name || 'agent'
    const handle = crewHandle(name)
    const dos = CREW_DOSSIER[name.toLowerCase()]
    const role = dos?.role || p.role || 'field agent'
    return {
      id: p.id,
      handle,
      model: model.toUpperCase(), // shown as a badge so you know which model each runs
      tool: model,
      cls: role,
      status: p.is_default ? 'online' : cycle[i % cycle.length],
      connected: true,
      ver: model,
      path: 'agent/' + handle.toLowerCase(),
      role,
      trust: TRUST_PM[pm] ?? 74,
      bio: dos?.bio || (p.description || p.system_prompt_append || 'no dossier on file.').slice(0, 220),
      spec: [`model: ${model}`, `${pm} clearance`, p.is_default ? 'default agent' : 'on call'],
      tasks: 0,
      up: '—',
      profile_id: p.id as string | null,
      integration_key: null as string | null,
      remote: false,
      editable: true,
      raw: {
        name: p.name || '', role: p.role || '', model: p.model || '', permission_mode: pm,
        system_prompt_append: p.system_prompt_append || '',
        is_default: !!p.is_default,
        inject_memory: p.inject_memory == null ? true : !!p.inject_memory,
        icon: p.icon || '◆', color: p.color || '#34e2ff',
        allowed_tools: p.allowed_tools || [], disallowed_tools: p.disallowed_tools || [],
      } as any,
    }
  })
  // enabled external runtimes join the same crew
  integrations.filter((it) => it.enabled).forEach((it) => {
    const handle = crewHandle(it.name)
    const model = it.model || 'remote'
    const dos = INTEGRATION_DOSSIER[it.key]
    // your own notes always win; otherwise a themed dossier; otherwise a generic bridge line
    const bio = (it.notes || it.blurb || dos?.bio || 'External runtime bridged into GRID//OS over the OpenAI-compatible API.').slice(0, 220)
    const reachable = it.last_status !== 'unreachable'
    crew.push({
      id: 'integration:' + it.key,
      handle,
      model: model.toUpperCase(),
      tool: it.name,
      cls: dos?.cls || 'External runtime',
      status: reachable ? 'online' : 'idle',
      connected: true,
      ver: model,
      path: it.endpoint || 'agent/' + it.key,
      role: dos?.role || 'External agent · bridged',
      trust: dos?.trust ?? 72,
      bio,
      spec: [dos?.spec || 'remote runtime', it.endpoint || 'no endpoint set', 'model: ' + model],
      tasks: 0,
      up: reachable ? 'bridged' : 'offline',
      profile_id: null,
      integration_key: it.key,
      remote: true,
      editable: false,
      raw: null as any,
    })
  })
  return crew
}

// Themed dossiers so a freshly-enabled integration reads like real crew, not a stub.
// The user's `notes` field overrides `bio` — this is just the good default when notes are blank.
const INTEGRATION_DOSSIER: Record<string, { role: string; cls: string; bio: string; spec: string; trust: number }> = {
  hermes: {
    role: 'Remote oracle · deep memory',
    cls: 'Off-site specialist',
    bio: 'Nous-forged runtime jacked in over the wire. Keeps a long memory and takes the hard reasoning calls — the crew’s off-site brain.',
    spec: 'remote reasoning runtime',
    trust: 78,
  },
  openclaw: {
    role: 'Browser operator · remote hands',
    cls: 'Web operator',
    bio: 'A gateway daemon that drives a live browser. Point it at the net and it clicks, reads pages, and reports back through the bridge.',
    spec: 'browser-driving gateway',
    trust: 70,
  },
  ollama: {
    role: 'Local model · on-metal',
    cls: 'On-prem runtime',
    bio: 'Runs entirely on your own hardware — no cloud, no wire out. A private model bridged into the grid for offline work.',
    spec: 'local on-metal model',
    trust: 75,
  },
  redacted: {
    role: 'External agent · bridged',
    cls: 'External runtime',
    bio: 'A bridged runtime speaking the OpenAI wire protocol, configured and jacked into the grid.',
    spec: 'remote runtime',
    trust: 72,
  },
}

const TONE_KIND: Record<string, string> = { ok: 'ok', warn: 'warn', err: 'err', info: 'sys' }
export function toneKind(tone: string): string { return TONE_KIND[tone] || 'out' }

// build the scrolling top-bar marquee from recent activity
export function tickerString(entries: { text: string }[]): string {
  if (!entries.length) return ''
  return entries.slice(0, 18).map((e) => e.text).join('   ·   ') + '   ·   '
}

export interface HostAgent { key: string; name: string; installed: boolean; path?: string | null; version?: string | null; blurb?: string }
export interface HostIntegration { key: string; name: string; enabled: boolean; endpoint?: string; model?: string; ssh?: string; notes?: string; transport?: string; blurb?: string; has_token?: boolean; last_status?: string; last_detail?: string }

// auto-discovered agent runtimes (+ configurable integrations) -> GRID//OS "AGENT AUTO-DETECT" list.
// Detected CLIs (claude/codex/gemini) are read-only status; configurable integrations toggle enable/disable.
export function mapIntegrations(agents: HostAgent[], integrations: HostIntegration[]) {
  const intByKey: Record<string, HostIntegration> = {}
  integrations.forEach((i) => { intByKey[i.key] = i })
  const seen = new Set<string>()
  const fromInteg = (i: HostIntegration) => ({
    endpoint: i.endpoint || '', model: i.model || '', ssh: i.ssh || '',
    hasToken: !!i.has_token, notes: i.notes || '', transport: i.transport || 'openai',
    lastStatus: i.last_status || '', lastDetail: i.last_detail || '',
  })
  const cards = agents.map((a) => {
    seen.add(a.key)
    const integ = intByKey[a.key]
    const toggleable = !!integ
    return {
      id: a.key,
      handle: a.name,
      tool: a.key,
      ver: a.version || (a.installed ? 'installed' : 'not installed'),
      path: a.path || integ?.endpoint || '—',
      installed: a.installed,
      toggleable,
      connected: toggleable ? !!integ!.enabled : a.installed,
      ...(toggleable ? fromInteg(integ!) : { endpoint: '', model: '', ssh: '', hasToken: false, notes: '', transport: 'openai', lastStatus: '', lastDetail: '' }),
    }
  })
  integrations.filter((i) => !seen.has(i.key)).forEach((i) => {
    cards.push({
      id: i.key, handle: i.name, tool: i.key, ver: i.enabled ? 'bound' : 'not bound',
      path: i.endpoint || '—', installed: !!i.enabled, toggleable: true, connected: !!i.enabled,
      ...fromInteg(i),
    })
  })
  return cards
}

export interface HostDream { id: string; status: string; content: string; cost_usd?: number; actions: any[]; applied: number[] }

function describeAction(a: any): string {
  const t = a?.type
  if (t === 'schedule') return `schedule "${a.name || '?'}"`
  if (t === 'rule') return `${a.action || 'ask'} rule · ${a.pattern || '?'}`
  if (t === 'agent') return `recruit "${a.name || '?'}"`
  if (t === 'fact') return `remember · ${(a.content || '').slice(0, 40)}`
  if (t === 'pipeline') return `pipeline "${a.name || '?'}"`
  return t || 'a suggestion'
}

// the agent's idle "dreams" (reflections proposing schedules/rules/agents/facts) -> Dream Engine fragments.
// WAKE manifests the dream's next un-applied suggestion via /api/dreams/{id}/apply.
export function mapDreams(list: HostDream[]) {
  return list.map((d) => {
    const actions = d.actions || []
    const applied = d.applied || []
    const firstUn = actions.findIndex((_a: any, i: number) => !applied.includes(i))
    const clean = (d.content || '').replace(/[#*`>_]/g, '').replace(/\s+/g, ' ').trim()
    const weird = Math.min(92, 34 + actions.length * 7 + Math.round((d.cost_usd || 0) * 60))
    const cost = d.cost_usd || 0
    // every proposed action, with its index + applied state, so each can be manifested independently
    const actionList = actions.map((a: any, i: number) => ({ idx: i, desc: describeAction(a), applied: applied.includes(i) }))
    const base = { id: d.id, agent: 'grid', weird, cost, body: (d.content || '').trim(), actionList }
    if (d.status === 'dreaming') {
      return { ...base, title: 'a fragment is forming…', status: 'lucid', weird: 66,
        progress: 12, frag: 'the deck is asleep — REM cycle in progress, reflecting on the week.', actionIdx: -1, actionList: [] }
    }
    if (d.status === 'failed') {
      return { ...base, title: 'dream collapsed', status: 'spent',
        progress: 100, frag: clean.slice(0, 200) || 'the cycle destabilised before anything surfaced.', actionIdx: -1 }
    }
    return {
      ...base,
      title: firstUn >= 0 ? '⚡ ' + describeAction(actions[firstUn]) : (actions.length ? 'all proposals manifested' : 'quiet cycle'),
      status: firstUn >= 0 ? 'lucid' : 'spent',
      progress: actions.length ? Math.round(applied.length / actions.length * 100) : 100,
      frag: clean.slice(0, 200) || 'a quiet cycle — nothing surfaced.',
      actionIdx: firstUn,
    }
  })
}

export interface HostRule {
  id: string; tool_name: string; field: string; match_type: string; pattern: string
  action: 'allow' | 'deny' | 'ask'; priority: number; enabled: number | boolean
  description?: string; hit_count?: number
}

const RULE_CLS: Record<string, { cls: string; verb: string }> = {
  allow: { cls: 'PASS', verb: 'auto-allow' },
  deny: { cls: 'HARDWALL', verb: 'block' },
  ask: { cls: 'CHALLENGE', verb: 'escalate to auth queue' },
}

// auto-approve rules -> "ICE protocols" / combat subroutines in the Skills app.
// Each rule is a pattern the deck auto-allows (PASS), blocks (HARDWALL), or escalates (CHALLENGE).
// pull a readable name out of a (possibly regex) rule pattern: "git\s+push\s+..." -> "GIT PUSH FORCE"
function skillName(pat: string, fallback: string): string {
  const cleaned = pat
    .replace(/\\[sbwdSBWD]/g, ' ')      // \s \b \w \d escapes
    .replace(/\[[^\]]*\]/g, ' ')        // [a-zA-Z] char classes
    .replace(/\{[^}]*\}/g, ' ')         // {1,3} quantifiers
    .replace(/[\\^$.*+?()|~/:-]/g, ' ') // remaining metacharacters
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
  const words = [...new Set(cleaned.split(/\s+/).filter((w) => w.length >= 2))]
  return words.slice(0, 3).join(' ').toUpperCase() || fallback.toUpperCase()
}

export function mapSkills(list: HostRule[]) {
  return list.map((r) => {
    const c = RULE_CLS[r.action] || RULE_CLS.ask
    const pat = r.pattern || '·'
    const name = skillName(pat, r.tool_name)
    return {
      id: r.id,
      name,
      tool: r.tool_name,
      pattern: pat,
      cls: c.cls,
      enabled: !!r.enabled,
      hits: r.hit_count || 0,
      desc: r.description || `${c.verb} when ${r.tool_name}·${r.field} matches (${r.match_type})`,
    }
  })
}

export interface HostPipeline { id: string; name: string; description?: string; stages: any[] }
export interface HostRun { id: string; pipeline_id: string; status: string; current_stage: number; stage_count: number }

// orchestration pipelines (chained agent jobs) -> GRID//OS "PIPELINES" app.
// Recent runs (ordered newest-first) are merged in to show live run status.
export function mapPipelines(pipelines: HostPipeline[], runs: HostRun[] = []) {
  return pipelines.map((p) => {
    const run = runs.find((r) => r.pipeline_id === p.id) // first match = latest run for this pipeline
    const running = !!run && run.status === 'running'
    const stageObjs = (p.stages || []) as any[]
    const stages = stageObjs.map((s: any) => (s && s.name) || 'stage')
    const remoteCount = stageObjs.filter((s: any) => s && s.integration_key).length
    return {
      id: p.id,
      name: (p.name || 'pipeline').toUpperCase(),
      desc: p.description || `${stages.length}-stage sequence`,
      stages,
      count: stages.length,
      remoteCount, // how many stages run on a bridged runtime
      status: running ? 'running' : run ? run.status : 'idle',
      progress: running ? `stage ${(run!.current_stage || 0) + 1}/${run!.stage_count || stages.length}` : '',
      running,
      runId: running && run ? run.id : '',
      stageObjs, // full stage data for the editor (name/prompt/profile_id/integration_key/model)
      rawName: p.name || 'pipeline',
      rawDesc: p.description || '',
    }
  })
}

export function mapApprovals(list: HostApproval[]) {
  return list.map((a) => {
    const ti = a.tool_input || {}
    const command = typeof ti.command === 'string' ? ti.command : ''
    const filePath = typeof ti.file_path === 'string' ? ti.file_path : ''
    const cmdHint = command ? ' ' + command.trim().split(/\s+/).slice(0, 2).join(' ') : ''
    return {
      id: a.id,
      taskId: a.task_id,
      tool: a.tool_name,
      agent: a.task_title || a.task_id.slice(0, 8),
      action: a.tool_name.toUpperCase() + cmdHint,
      risk: riskOf(a),
      detail: detailOf(a),
      // the editable target: Bash command or a file path — used for approve-with-edit + "always allow"
      editField: command ? 'command' : (filePath ? 'file_path' : ''),
      editValue: command || filePath,
      rawInput: ti,
      fullInput: JSON.stringify(ti, null, 2).slice(0, 1200),
      ts: relTime(a.created_at),
    }
  })
}

export interface HostSchedule {
  id: string
  name: string
  cron_expr: string
  task_template: { prompt?: string; kind?: string; repo_path?: string; verify_command?: string; profile_id?: string | null; dream?: boolean }
  enabled: number
  overlap_policy: string
  last_run_at: string | null
  next_run_at: string | null
  last_task_id: string | null
}

function schedFmt(ts: string | null): string {
  if (!ts) return '—'
  try {
    return new Date(ts.endsWith('Z') ? ts : ts + 'Z').toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ts
  }
}

// mapSchedules — GRID//OS "STANDING ORDERS" cron app. Mirrors the PIP Scheduler view fields; `raw` carries the
// full PUT/POST body (cron/prompt/kind/overlap/dream) so the editor can round-trip an existing schedule.
export function mapSchedules(rows: HostSchedule[]) {
  return (rows || []).map((s) => {
    const t = s.task_template || {}
    return {
      id: s.id,
      name: s.name,
      cron: s.cron_expr,
      prompt: t.prompt || '',
      promptShort: (t.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 100),
      enabled: !!s.enabled,
      armLabel: s.enabled ? 'ARMED' : 'IDLE',
      overlap: s.overlap_policy || 'skip',
      dream: !!t.dream,
      kind: t.kind || 'general',
      next: schedFmt(s.next_run_at),
      last: schedFmt(s.last_run_at),
      lastTaskId: s.last_task_id || '',
      raw: {
        name: s.name,
        cron_expr: s.cron_expr,
        prompt: t.prompt || '',
        kind: t.kind || 'general',
        repo_path: t.repo_path || null,
        verify_command: t.verify_command || null,
        profile_id: t.profile_id || null,
        overlap_policy: s.overlap_policy || 'skip',
        dream: !!t.dream,
      },
    }
  })
}

// ---- Task detail / execution log (GRID//OS "EXEC LOG" drill-down) -------------
// Mirrors the PIP TaskDetail view: header meta + the full persisted event stream
// rendered as phosphor terminal lines. Styles are precomputed here so the
// dc-runtime template stays a single flat sc-for.

function shortIn(input: Record<string, any> | undefined): string {
  if (!input) return ''
  const s = input.command ?? input.file_path ?? input.pattern ?? input.url ?? JSON.stringify(input)
  return typeof s === 'string' ? (s.length > 140 ? s.slice(0, 140) + '…' : s) : ''
}

function evLineStyle(color: string, opts: { mono?: boolean; italic?: boolean; center?: boolean; size?: number; bold?: boolean } = {}): string {
  return (opts.mono ? 'font-family:var(--font-mono);' : 'font-family:var(--font-term);') +
    'font-size:' + (opts.size || 12) + 'px;line-height:1.55;white-space:pre-wrap;word-break:break-word;color:' + color +
    (opts.italic ? ';font-style:italic;opacity:.82' : '') + (opts.bold ? ';font-weight:700' : '') +
    (opts.center ? ';text-align:center;letter-spacing:.24em;opacity:.8' : '')
}

export function mapTaskMeta(t?: Task) {
  if (!t) return null
  const active = ACTIVE_STATUSES.includes(t.status)
  const statusColor = t.status === 'done' ? 'var(--ok)'
    : t.status === 'failed' ? 'var(--danger)'
    : t.status === 'cancelled' ? 'var(--text-dim)'
    : t.status === 'awaiting_approval' ? 'var(--warn)' : 'var(--accent)'
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    statusLabel: t.status.replace(/_/g, ' ').toUpperCase(),
    statusColor,
    agent: t.agent_name || (t.integration_key ? '⇄ ' + t.integration_key : 'local agent'),
    cost: '$' + (t.total_cost_usd ?? 0).toFixed(3),
    tokens: (((t.input_tokens || 0) + (t.output_tokens || 0)) / 1000).toFixed(1) + 'k tok',
    turns: t.num_turns != null ? t.num_turns + ' turns' : '',
    error: t.error || '',
    hasError: !!t.error,
    isRepo: t.kind === 'repo',
    branch: t.branch || '',
    hasWorktree: t.kind === 'repo' && !!t.worktree_path,
    active,
    terminal: !active,
    canCancel: active,
    canRetry: !active && t.kind !== 'chat',
    canFollow: active && t.status !== 'queued',
    running: t.status === 'running',
  }
}

export function mapTaskEvents(events: TaskEvent[]) {
  const resultBy: Record<string, TaskEvent> = {}
  for (const e of events) if (e.type === 'tool_result') resultBy[e.payload?.tool_use_id] = e
  const rows: any[] = []
  for (const e of events) {
    const key = e.task_id + '-' + e.seq
    const p = e.payload || {}
    if (e.type === 'assistant_text') {
      rows.push({ key, ico: '', icoStyle: '', line: p.text || '', lineStyle: evLineStyle('var(--text-bright)'), hasSub: false, sub: '', subStyle: '' })
    } else if (e.type === 'thinking') {
      rows.push({ key, ico: '', icoStyle: '', line: p.text || '', lineStyle: evLineStyle('var(--text-dim)', { italic: true, size: 11 }), hasSub: false, sub: '', subStyle: '' })
    } else if (e.type === 'tool_use') {
      const r = resultBy[p.tool_use_id]
      const failed = r && r.payload?.is_error
      const mark = failed ? '✗' : (r ? '✓' : '▸')
      const mc = failed ? 'var(--danger)' : (r ? 'var(--ok)' : 'var(--warn)')
      const res = r ? String(r.payload?.content ?? '').slice(0, 600) : ''
      rows.push({
        key, ico: mark, icoStyle: 'font-family:var(--font-mono);font-size:12px;color:' + mc + ';flex:none',
        line: (p.tool || 'tool') + '  ' + shortIn(p.input), lineStyle: evLineStyle('var(--accent-2)', { mono: true, size: 11 }),
        hasSub: !!res, sub: res, subStyle: evLineStyle(failed ? 'var(--danger)' : 'var(--text-dim)', { mono: true, size: 10 }),
      })
    } else if (e.type === 'verify_output') {
      const cmd = p.stream === 'cmd'
      const col = cmd ? 'var(--accent-2)' : (p.stream === 'status' ? (p.exit_code === 0 ? 'var(--ok)' : 'var(--danger)') : 'var(--text-dim)')
      rows.push({ key, ico: '', icoStyle: '', line: cmd ? ('$ ' + p.line) : (p.line ?? ''), lineStyle: evLineStyle(col, { mono: true, size: 11, bold: p.stream === 'status' }), hasSub: false, sub: '', subStyle: '' })
    } else if (e.type === 'status_change') {
      rows.push({ key, ico: '', icoStyle: '', line: '— ' + (p.to || '') + ' —', lineStyle: evLineStyle('var(--text-dim)', { mono: true, size: 10, center: true }), hasSub: false, sub: '', subStyle: '' })
    } else if (e.type === 'approval_requested') {
      rows.push({ key, ico: '⏸', icoStyle: 'color:var(--warn);flex:none', line: 'APPROVAL: ' + (p.tool || '') + ' ' + shortIn(p.input), lineStyle: evLineStyle('var(--warn)', { mono: true, size: 11 }), hasSub: false, sub: '', subStyle: '' })
    } else if (e.type === 'approval_resolved') {
      rows.push({ key, ico: '●', icoStyle: 'color:var(--warn);flex:none;opacity:.7', line: (p.resolution || '') + ': ' + (p.tool || ''), lineStyle: evLineStyle('var(--warn)', { mono: true, size: 10.5 }), hasSub: false, sub: '', subStyle: '' })
    } else if (e.type === 'user_message') {
      rows.push({ key, ico: '»', icoStyle: 'color:var(--warn);flex:none;font-weight:700', line: 'OVERSEER: ' + (p.text || ''), lineStyle: evLineStyle('var(--warn)', { size: 12 }), hasSub: false, sub: '', subStyle: '' })
    } else if (e.type === 'result') {
      rows.push({ key, ico: '', icoStyle: '', line: '═══ RESULT · ' + (p.subtype || '') + ' · $' + Number(p.total_cost_usd ?? 0).toFixed(3) + ' ═══', lineStyle: evLineStyle(p.is_error ? 'var(--danger)' : 'var(--ok)', { mono: true, size: 11, bold: true }), hasSub: !!p.text, sub: p.text || '', subStyle: evLineStyle('var(--text-bright)', { size: 12 }) })
    }
  }
  for (const r of rows) r.hasIco = !!r.ico // dc-runtime sc-if wants a boolean, not string truthiness
  return rows
}
