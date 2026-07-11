import { useCallback, useEffect, useRef, useState } from 'react'
import { type BootVariant, BOOT_VARIANTS } from './CyberBoot'
import { useStore } from '../store'
import { wsClient } from '../lib/ws'
import { get, post, del, api, getToken } from '../lib/api'
import { getActiveBaseUrl } from '../lib/connections'
import { getNotifyPrefs, requestNotifyPermission } from '../lib/notify'
import { mapBoard, mapApprovals, mapMemories, mapCrew, mapIntegrations, mapDreams, mapSkills, mapPipelines, mapSchedules, mapStats, mapTaskMeta, mapTaskEvents, tickerString, toneKind, type HostApproval, type HostFact, type HostEpisode, type HostProfile, type HostAgent, type HostIntegration, type HostDream, type HostRule, type HostPipeline, type HostRun, type HostSchedule, type HostStats } from './cyberBridge'
import type { Task, TaskEvent } from '../lib/types'

const CYBER_VIDEOS: BootVariant[] = ['crash', 'acid', 'nikon', 'cereal']

/**
 * Per-load handshake nonce for the GRID//OS bridge (see the `onMsg` security gate).
 * Uses crypto.getRandomValues (NOT randomUUID) so it also works when the console is
 * reached over a plain-http LAN address, which is not a secure context and where
 * crypto.randomUUID is undefined.
 */
function makeBridgeNonce(): string {
  const a = new Uint8Array(16)
  crypto.getRandomValues(a)
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Which OS-boot plays after login (rendered inside GRID//OS, on the deck's screen):
 *   'gridos'  → no video; login goes straight to the desktop
 *   a variant → one of our Hackers boot videos
 * Stored under `agentos_cyberboot`; default = a random Hackers video each jack-in.
 */
export function loadCyberBoot(): 'gridos' | BootVariant {
  const v = typeof localStorage !== 'undefined' ? localStorage.getItem('agentos_cyberboot') : null
  if (v === 'gridos') return 'gridos'
  if (v && BOOT_VARIANTS.some((b) => b.id === v)) return v as BootVariant
  return 'random'
}

/**
 * The Cyber theme = GRID//OS: a full-screen cyberpunk desktop served from /cyber/
 * in an isolated iframe. This shell also runs the data bridge: it pushes real
 * AgenticOS tasks (→ Board) and pending approvals (→ Auth) into GRID//OS over
 * postMessage, and relays Approve/Deny back to /api/approvals/{id}/resolve.
 *
 * Shift/Ctrl+Esc, the corner tab, or a `gridos:jackout` message returns to PIP-OS.
 */
export default function CyberShell({ onExit }: { onExit: () => void }) {
  const [osboot] = useState(() => {
    const choice = loadCyberBoot()
    if (choice === 'gridos') return 'gridos'
    return choice === 'random' ? CYBER_VIDEOS[Math.floor(Math.random() * CYBER_VIDEOS.length)] : choice
  })

  const iframeRef = useRef<HTMLIFrameElement>(null)
  // Handshake nonce handed to the deck via the iframe src (?n=...); every inbound
  // gridos:action must echo it back. Generated once per mount (stable identity).
  const [bridgeNonce] = useState(makeBridgeNonce)
  const tasks = useStore((s) => s.tasks)
  const approvalBump = useStore((s) => s.approvalBump)
  const [approvals, setApprovals] = useState<HostApproval[]>([])
  // GRID//OS IRC ⇄ real chat tasks: stream deltas from the task's WS into the iframe
  const streaming = useStore((s) => s.streaming)
  const taskEvents = useStore((s) => s.taskEvents)
  const ircTasksRef = useRef<Record<string, string>>({}) // IRC channel -> chat task id
  const ircFwdSeqRef = useRef<Record<string, number>>({}) // task id -> last forwarded assistant_text seq
  const [detailId, setDetailId] = useState<string>('') // board task drilled into the EXEC LOG viewer

  // cyber mode doesn't mount the task views, so seed the store here; WS keeps it live
  useEffect(() => {
    get<Task[]>('/api/tasks').then((list) => useStore.getState().setTasks(list)).catch(() => {})
  }, [])

  // pending approvals: initial load + refetch on every approval event (WS bumps this)
  useEffect(() => {
    get<HostApproval[]>('/api/approvals?status=pending').then(setApprovals).catch(() => {})
  }, [approvalBump])

  // memory: facts (forgettable) + episodes (auto-logged run history) — matches PIP-OS Holotapes
  const [facts, setFacts] = useState<HostFact[]>([])
  const [episodes, setEpisodes] = useState<HostEpisode[]>([])
  const fetchFacts = useCallback(() => {
    get<HostFact[]>('/api/memory/facts').then(setFacts).catch(() => {})
    get<HostEpisode[]>('/api/memory/episodes').then(setEpisodes).catch(() => {})
  }, [])
  useEffect(() => { fetchFacts() }, [fetchFacts])

  // curated import of local Claude archives -> MEMORY BANK scan flow; the state
  // rides the agentos:data push, so the deck just renders what the host holds
  type MemImport = { status: string; proposals: string[]; error?: string | null }
  const [memImport, setMemImport] = useState<MemImport>({ status: 'idle', proposals: [] })
  useEffect(() => {
    get<MemImport>('/api/memory/import/status').then(setMemImport).catch(() => {})
  }, [])
  useEffect(() => {
    if (memImport.status !== 'scanning') return
    const t = setInterval(() => {
      get<MemImport>('/api/memory/import/status').then(setMemImport).catch(() => {})
    }, 3000)
    return () => clearInterval(t)
  }, [memImport.status])

  // agent profiles -> crew roster
  const [profiles, setProfiles] = useState<HostProfile[]>([])
  useEffect(() => {
    get<HostProfile[]>('/api/profiles').then(setProfiles).catch(() => {})
  }, [])

  // idle "dreams" (agent reflections proposing schedules/rules/agents) -> Dream Engine
  const [dreams, setDreams] = useState<HostDream[]>([])
  const fetchDreams = useCallback(() => {
    get<HostDream[]>('/api/dreams').then(setDreams).catch(() => {})
  }, [])
  useEffect(() => { fetchDreams() }, [fetchDreams])

  // auto-approve rules -> Skills app (ICE protocols)
  const [rules, setRules] = useState<HostRule[]>([])
  const fetchRules = useCallback(() => {
    get<HostRule[]>('/api/rules').then(setRules).catch(() => {})
  }, [])
  useEffect(() => { fetchRules() }, [fetchRules])

  // orchestration pipelines + their recent runs -> Pipelines app
  const [pipelines, setPipelines] = useState<HostPipeline[]>([])
  const [runs, setRuns] = useState<HostRun[]>([])
  // live WS run updates (status/summary) overlaid on the REST snapshot below
  const pipelineRuns = useStore((s) => s.pipelineRuns)
  const fetchPipelines = useCallback(() => {
    get<HostPipeline[]>('/api/pipelines').then(setPipelines).catch(() => {})
    get<HostRun[]>('/api/pipelines/runs/recent').then(setRuns).catch(() => {})
  }, [])
  useEffect(() => { fetchPipelines() }, [fetchPipelines])

  // recurring cron jobs -> Standing Orders (scheduler) app
  const [schedules, setSchedules] = useState<HostSchedule[]>([])
  const fetchSchedules = useCallback(() => {
    get<HostSchedule[]>('/api/schedules').then(setSchedules).catch(() => {})
  }, [])
  useEffect(() => { fetchSchedules() }, [fetchSchedules])

  // away-notification config (phone push) -> Settings > Notifications
  type NotifyCfg = { channel: string; ntfy_topic: string; telegram_chat: string; webhook_url: string; on_approval: boolean; on_finish: boolean; has_telegram_token: boolean }
  const [notifyCfg, setNotifyCfg] = useState<NotifyCfg | null>(null)
  const fetchNotify = useCallback(() => {
    get<NotifyCfg>('/api/notifications').then(setNotifyCfg).catch(() => {})
  }, [])
  useEffect(() => { fetchNotify() }, [fetchNotify])

  // opt-in boot-level autostart (Windows scheduled task) -> Settings > System
  const [autostartSt, setAutostartSt] = useState<Record<string, unknown> | null>(null)
  useEffect(() => {
    get<Record<string, unknown>>('/api/system/autostart').then(setAutostartSt).catch(() => {})
  }, [])

  // LAN-exposure override + current bind state -> Settings > System
  const [network, setNetwork] = useState<Record<string, unknown> | null>(null)
  useEffect(() => {
    get<Record<string, unknown>>('/api/system/network').then(setNetwork).catch(() => {})
  }, [])

  // desktop self-update status -> Settings > System (update panel above BOOT CHECKLIST)
  const [updateSt, setUpdateSt] = useState<Record<string, unknown> | null>(null)
  const fetchUpdate = useCallback((force?: boolean) => {
    const req = force ? post<Record<string, unknown>>('/api/update/check') : get<Record<string, unknown>>('/api/update/status')
    req.then(setUpdateSt).catch(() => {})
  }, [])
  useEffect(() => { fetchUpdate() }, [fetchUpdate])

  // auto-discovered agent runtimes + configurable integrations -> Settings > Integrations
  type HostCheck = { key: string; label: string; ok: boolean; detail: string; severity: string }
  const [detected, setDetected] = useState<HostAgent[]>([])
  const [rawInteg, setRawInteg] = useState<HostIntegration[]>([])
  const [env, setEnv] = useState<{ checklist: HostCheck[]; agentos_version: string; sdk_version: string }>({ checklist: [], agentos_version: '', sdk_version: '' })
  const fetchInteg = useCallback((force?: boolean) => {
    get<{ agents: HostAgent[]; checklist?: HostCheck[]; agentos_version?: string; sdk_version?: string }>(`/api/system/environment${force ? '?force=1' : ''}`).then((d) => {
      setDetected(d.agents || [])
      setEnv({ checklist: d.checklist || [], agentos_version: d.agentos_version || '', sdk_version: d.sdk_version || '' })
    }).catch(() => {})
    get<HostIntegration[]>('/api/integrations').then(setRawInteg).catch(() => {})
  }, [])
  useEffect(() => { fetchInteg() }, [fetchInteg])

  // live activity (WS task status changes) -> deck ticker + terminal feed
  const ticker = useStore((s) => s.ticker)

  // Mission-Control-equivalent telemetry (cost meters + task counts), refreshed on activity
  const [stats, setStats] = useState<HostStats | null>(null)
  useEffect(() => { get<HostStats>('/api/stats').then(setStats).catch(() => {}) }, [ticker])

  const sendData = useCallback(() => {
    const w = iframeRef.current?.contentWindow
    if (!w) return
    // overlay live WS run updates onto the REST snapshot so the deck sees status
    // + result_summary the instant a run finishes, not on the next refetch
    const mergedRuns: HostRun[] = runs.map((r) => ({ ...r, ...(pipelineRuns[r.id] ?? {}) }))
    for (const live of Object.values(pipelineRuns) as HostRun[]) {
      if (!mergedRuns.some((r) => r.id === live.id)) mergedRuns.unshift(live)
    }
    w.postMessage({
      type: 'agentos:data',
      board: mapBoard(tasks),
      approvals: mapApprovals(approvals),
      memories: mapMemories(facts, episodes),
      memScan: memImport,
      agents: mapCrew(profiles, rawInteg),
      integrations: mapIntegrations(detected, rawInteg),
      dreams: mapDreams(dreams),
      skills: mapSkills(rules),
      pipelines: mapPipelines(pipelines, mergedRuns),
      schedules: mapSchedules(schedules),
      notify: notifyCfg,
      notifyPerm: getNotifyPrefs().permission,
      autostart: autostartSt,
      security: network,
      update: updateSt,
      stats: mapStats(stats, tasks),
      env: { checklist: env.checklist, agentos_version: env.agentos_version, sdk_version: env.sdk_version },
      ticker: tickerString(ticker),
    }, '*')
  }, [tasks, approvals, facts, episodes, memImport, profiles, detected, rawInteg, dreams, rules, pipelines, runs, pipelineRuns, schedules, notifyCfg, autostartSt, network, updateSt, stats, env, ticker])

  // push whenever the data changes
  useEffect(() => { sendData() }, [sendData])

  // a pipeline run crossing running → terminal is the completion moment: relay one
  // phosphor line into the deck's terminal (GRID//OS's own voice; not gated on on_finish)
  const runStatusRef = useRef<Record<string, string>>({})
  useEffect(() => {
    const w = iframeRef.current?.contentWindow
    const lines: { k: string; t: string }[] = []
    for (const run of Object.values(pipelineRuns) as any[]) {
      const prev = runStatusRef.current[run.id]
      const terminal = run.status === 'done' || run.status === 'failed' || run.status === 'cancelled'
      if (prev === 'running' && terminal) {
        const name = run.pipeline_name || 'sequence'
        if (run.status === 'done') {
          lines.push({ k: 'ok', t: `SEQUENCE '${name}' COMPLETE ▓ ${String(run.result_summary ?? '').slice(0, 100)}` })
        } else if (run.status === 'failed') {
          lines.push({ k: 'err', t: `SEQUENCE '${name}' FLATLINED @ stage ${(run.current_stage ?? 0) + 1} · ${String(run.error ?? '')}` })
        } else {
          lines.push({ k: 'warn', t: `SEQUENCE '${name}' ABORTED` })
        }
      }
      runStatusRef.current[run.id] = run.status
    }
    if (lines.length && w) w.postMessage({ type: 'agentos:log', lines }, '*')
  }, [pipelineRuns])

  // relay tracked IRC chat tasks' live token stream + final reply into GRID//OS
  useEffect(() => {
    const w = iframeRef.current?.contentWindow
    if (!w) return
    for (const [ch, taskId] of Object.entries(ircTasksRef.current)) {
      const stream = streaming[taskId]
      if (stream) w.postMessage({ type: 'agentos:chat-delta', ch, text: stream }, '*')
      for (const e of taskEvents[taskId] ?? []) {
        if (e.seq <= (ircFwdSeqRef.current[taskId] ?? 0)) continue
        if (e.type === 'assistant_text') {
          ircFwdSeqRef.current[taskId] = e.seq
          w.postMessage({ type: 'agentos:chat-reply', ch, text: e.payload.text, ok: true }, '*')
        } else if (e.type === 'memory_write') {
          // memory_write precedes its assistant_text (lower seq), so advancing
          // the forward cursor here never skips the reply that follows
          ircFwdSeqRef.current[taskId] = e.seq
          const bits = [
            ...(e.payload.remember ?? []).map((r: any) => '◈ memory write — ' + r.content),
            ...(e.payload.forget ?? []).map((c: string) => '◈ memory drop — ' + c),
          ]
          w.postMessage({ type: 'agentos:chat-sys', ch, text: bits.join(' · ') }, '*')
        }
      }
    }
  }, [streaming, taskEvents])

  // relay the drilled-into task's meta + full event stream into the GRID//OS EXEC LOG viewer
  useEffect(() => {
    const w = iframeRef.current?.contentWindow
    if (!w || !detailId) return
    w.postMessage({
      type: 'agentos:task-detail',
      id: detailId,
      meta: mapTaskMeta(tasks[detailId]),
      events: mapTaskEvents(taskEvents[detailId] ?? []),
      stream: streaming[detailId] ?? '',
    }, '*')
  }, [detailId, tasks, taskEvents, streaming])

  // a newly-detected build drops ONE warn line into the deck terminal (once per
  // version — the boot/every-few-hours scan shouldn't nag on every push).
  // Gated on deckReady: the update fetch resolves near-instantly (esp. cached), so
  // a naive post races the iframe boot and gets DROPPED before the deck attaches its
  // message listener. We only announce once the deck has signalled gridos:ready (its
  // listener is live), and we re-run this on ready — so the proactive boot announce
  // reliably surfaces, matching PIP-OS's in-page COMMS push.
  const updateAnnouncedRef = useRef<string>('')
  const deckReadyRef = useRef(false)
  const announceUpdate = useCallback(() => {
    if (!deckReadyRef.current) return
    const u = updateSt as { update_available?: boolean; latest?: string } | null
    if (!u || !u.update_available || !u.latest) return
    const key = 'agentos_update_announced'
    if (updateAnnouncedRef.current === u.latest || localStorage.getItem(key) === u.latest) return
    updateAnnouncedRef.current = u.latest
    localStorage.setItem(key, u.latest)
    const w = iframeRef.current?.contentWindow
    if (w) w.postMessage({ type: 'agentos:log', lines: [{ k: 'warn', t: `[grid] ▲ UPDATE ON THE WIRE — Rezident v${u.latest} · Settings ▸ System to pull` }] }, '*')
  }, [updateSt])
  useEffect(() => { announceUpdate() }, [announceUpdate])

  // stream new activity into the deck's terminal as it happens
  const seenRef = useRef<Set<string>>(new Set())
  const initedRef = useRef(false)
  useEffect(() => {
    const w = iframeRef.current?.contentWindow
    const fresh: { k: string; t: string }[] = []
    for (let i = ticker.length - 1; i >= 0; i--) {
      const e = ticker[i]
      const key = e.ts + '|' + e.text
      if (!seenRef.current.has(key)) {
        seenRef.current.add(key)
        if (initedRef.current) fresh.push({ k: toneKind(e.tone), t: '[grid] ' + e.text })
      }
    }
    initedRef.current = true
    if (fresh.length && w) w.postMessage({ type: 'agentos:log', lines: fresh }, '*')
  }, [ticker])

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      // SECURITY (load-bearing): the GRID//OS bridge turns postMessages into REST
      // calls carrying the operator's bearer token, so it must only ever trust its
      // OWN deck iframe. Reject anything that did not come from the deck iframe's
      // window (blocks a parent/opener/sibling that framed or window.open'd us) and
      // anything not same-origin (the deck is served same-origin from /cyber/).
      // Applies to ALL message types below (ready/jackout/action).
      if (e.source !== iframeRef.current?.contentWindow) return
      if (e.origin !== window.location.origin) return
      const d = e.data
      if (!d || typeof d !== 'object') return
      if (d.type === 'gridos:jackout') onExit()
      else if (d.type === 'gridos:ready') { deckReadyRef.current = true; sendData(); announceUpdate() }
      else if (d.type === 'gridos:action') {
        // SECURITY (belt to the source-check suspenders): every action must echo the
        // per-load handshake nonce we handed the deck via the iframe src (?n=...).
        // Drop actions with a wrong/absent nonce.
        if (d.n !== bridgeNonce) return
        if ((d.action === 'approve' || d.action === 'approve_edit' || d.action === 'deny') && d.id) {
          const body: Record<string, unknown> = { action: d.action }
          if (d.input !== undefined) body.input = d.input
          if (d.reason) body.reason = d.reason
          if (d.create_rule) body.create_rule = d.create_rule
          post(`/api/approvals/${d.id}/resolve`, body)
            .then(() => useStore.getState().bumpApprovals(-1))
            .catch(() => {})
        } else if (d.action === 'forget' && d.id) {
          del(`/api/memory/facts/${d.id}`).then(fetchFacts).catch(() => {})
        } else if (d.action === 'integration' && d.key) {
          const integ = rawInteg.find((i) => i.key === d.key)
          // endpoint/notes come from the config form when present, else preserve
          // the current values; token only sent when the user typed a new one.
          const body: Record<string, unknown> = {
            enabled: !!d.enable,
            endpoint: d.endpoint !== undefined ? d.endpoint : (integ?.endpoint || ''),
            model: d.model !== undefined ? d.model : (integ?.model || ''),
            ssh: d.ssh !== undefined ? d.ssh : (integ?.ssh || ''),
            notes: d.notes !== undefined ? d.notes : (integ?.notes || ''),
            transport: d.transport !== undefined ? d.transport : (integ?.transport || 'openai'),
          }
          if (d.token) body.token = d.token
          api(`/api/integrations/${d.key}`, { method: 'PUT', body: JSON.stringify(body) }).then(fetchInteg).catch(() => {})
        } else if (d.action === 'test-integration' && d.key) {
          // probe the endpoint; refetch pushes the updated last_status back to GRID//OS
          post(`/api/integrations/${d.key}/test`).then(fetchInteg).catch(() => {})
        } else if (d.action === 'login-integration' && d.key) {
          // start the hidden browser sign-in and stream its progress into the
          // deck; the backend enables the slot on login success (signed in =
          // connected & enabled), so probe + refetch flips the card green itself
          // — no separate Save step needed, mirroring PIP-OS
          type Login = { running: boolean; done: boolean; ok: boolean; url: string; detail: string }
          const push = (st: Partial<Login>) =>
            iframeRef.current?.contentWindow?.postMessage({ type: 'agentos:login-status', key: d.key, ...st }, '*')
          ;(async () => {
            try {
              let st = await post<Login>(`/api/integrations/${d.key}/login`)
              push(st)
              const t0 = Date.now()
              while (!st.done && Date.now() - t0 < 6 * 60_000) {
                await new Promise((r) => setTimeout(r, 2500))
                st = await get<Login>(`/api/integrations/${d.key}/login`)
                push(st)
              }
              if (st.done && st.ok) {
                push({ running: false, done: true, ok: true, url: '', detail: 'signed in ✓ — verifying the link…' })
                await post(`/api/integrations/${d.key}/test`).catch(() => {})
                fetchInteg()
              }
            } catch (e) {
              push({ running: false, done: true, ok: false, url: '', detail: e instanceof Error ? e.message : 'could not start the sign-in' })
            }
          })()
        } else if (d.action === 'create-task' && d.title && d.prompt) {
          // deploy a task from GRID//OS to any agent (Claude persona or integration)
          post('/api/tasks', {
            title: String(d.title).slice(0, 200), prompt: String(d.prompt), kind: 'general',
            profile_id: d.profile_id || null, integration_key: d.integration_key || null,
          }).catch(() => {})
        } else if (d.action === 'terminal-run' && d.prompt) {
          // the deck's typed `run "<task>"` — a REAL task; echo the accepted id back to the terminal
          const reply = (ok: boolean, extra: Record<string, unknown>) =>
            iframeRef.current?.contentWindow?.postMessage({ type: 'agentos:term-reply', ok, ...extra }, '*')
          post<Task>('/api/tasks', {
            title: String(d.title || d.prompt).slice(0, 200), prompt: String(d.prompt), kind: 'general',
            profile_id: d.profile_id || null, integration_key: d.integration_key || null,
          })
            .then((task) => reply(true, { id: task.id, short: '#' + task.id.slice(0, 8) }))
            .catch((e) => reply(false, { error: e instanceof Error ? e.message : 'request failed' }))
        } else if (d.action === 'cancel-task' && d.id) {
          post(`/api/tasks/${d.id}/cancel`).catch(() => {})
        } else if (d.action === 'retry-task' && d.id) {
          post(`/api/tasks/${d.id}/retry`).catch(() => {})
        } else if (d.action === 'rescan-env') {
          fetchInteg(true)  // force a fresh /api/system/environment probe
        } else if (d.action === 'dispatch-integration' && d.key) {
          // send a prompt to the runtime; push the reply back into the iframe
          const reply = (ok: boolean, text: string) => {
            const w = iframeRef.current?.contentWindow
            if (w) w.postMessage({ type: 'agentos:dispatch-reply', key: d.key, ok, reply: text }, '*')
          }
          post<{ reply?: string }>(`/api/integrations/${d.key}/dispatch`, { prompt: d.prompt || '' })
            .then((r) => reply(true, r.reply ?? '(no reply)'))
            .catch((e) => reply(false, e instanceof Error ? e.message : 'dispatch failed'))
        } else if (d.action === 'chat-integration' && d.key && Array.isArray(d.messages)) {
          // live IRC DM with a runtime: post the whole history, push the reply back
          const reply = (ok: boolean, text: string) => {
            const w = iframeRef.current?.contentWindow
            if (w) w.postMessage({ type: 'agentos:chat-reply', key: d.key, ch: d.ch, ok, reply: text }, '*')
          }
          post<{ reply?: string }>(`/api/integrations/${d.key}/chat`, { messages: d.messages })
            .then((r) => reply(true, r.reply ?? '(no reply)'))
            .catch((e) => reply(false, e instanceof Error ? e.message : 'chat failed'))
        } else if (d.action === 'memory-scan') {
          post<MemImport>('/api/memory/import/scan').then(setMemImport).catch(() => {})
        } else if (d.action === 'memory-scan-apply' && Array.isArray(d.facts) && d.facts.length) {
          post('/api/memory/import/apply', { facts: d.facts })
            .then(() => { setMemImport({ status: 'applied', proposals: [] }); fetchFacts() })
            .catch(() => {})
        } else if (d.action === 'memory-scan-dismiss') {
          post('/api/memory/import/dismiss')
            .then(() => setMemImport({ status: 'dismissed', proposals: [] }))
            .catch(() => {})
        } else if (d.action === 'crew-home' && d.id) {
          // agent detail FILES drawer: fetch the persona's home listing, relay it
          // pre-formatted (bridge philosophy — the deck only renders strings)
          const fmtB = (n: number) =>
            n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`
          const ago = (mtime: number) => {
            const ms = Date.now() - mtime * 1000
            const days = Math.floor(ms / 86400000)
            if (days > 0) return `${days}d ago`
            const hrs = Math.floor(ms / 3600000)
            if (hrs > 0) return `${hrs}h ago`
            const mins = Math.floor(ms / 60000)
            return mins > 0 ? `${mins}m ago` : 'just now'
          }
          get<{ files: { path: string; size: number; mtime: number }[]; count: number; bytes: number; truncated: boolean }>(`/api/profiles/${d.id}/home`)
            .then((h) => {
              const w = iframeRef.current?.contentWindow
              if (!w) return
              w.postMessage({
                type: 'agentos:crew-home', id: d.id, truncated: !!h.truncated,
                label: h.count ? `${h.count} file${h.count === 1 ? '' : 's'} · ${fmtB(h.bytes)}` : 'empty',
                files: (h.files || []).map((f) => ({ name: f.path, size: fmtB(f.size), ago: ago(f.mtime) })),
              }, '*')
            })
            .catch(() => {})
        } else if (d.action === 'crew-home-file' && d.id && d.path) {
          // inline preview of one home file in the agent dossier
          get<{ path: string; size: number; binary: boolean; truncated: boolean; content: string | null }>(
            `/api/profiles/${d.id}/home/file?path=${encodeURIComponent(String(d.path))}`
          )
            .then((f) => {
              const w = iframeRef.current?.contentWindow
              if (w) w.postMessage({ type: 'agentos:crew-home-file', id: d.id, path: f.path, binary: !!f.binary, truncated: !!f.truncated, content: f.content ?? '' }, '*')
            })
            .catch(() => {})
        } else if (d.action === 'crew-home-download' && d.id && d.path) {
          // download runs in the TOP window (the deck iframe never sees the token)
          fetch(`${getActiveBaseUrl()}/api/profiles/${d.id}/home/download?path=${encodeURIComponent(String(d.path))}`, {
            headers: { Authorization: `Bearer ${getToken()}` },
          })
            .then(async (res) => {
              if (!res.ok) return
              const blob = await res.blob()
              const a = document.createElement('a')
              a.href = URL.createObjectURL(blob)
              a.download = String(d.path).split('/').pop() || 'file'
              a.click()
              URL.revokeObjectURL(a.href)
            })
            .catch(() => {})
        } else if (d.action === 'chat-send' && d.text && (d.key || d.profileId)) {
          // live IRC DM: drive a REAL chat task. Integration → persistent ACP/HTTP session;
          // local persona → a kind:chat ClaudeSDKClient bound to that profile (real tools,
          // cost, approvals). Its WS deltas + final reply are relayed to the iframe below.
          const label = d.name ? String(d.name) : String(d.key || d.profileId)
          const ch = String(d.ch || '@' + (d.key || d.profileId))
          const existing = ircTasksRef.current[ch]
          if (existing) {
            post(`/api/tasks/${existing}/message`, { text: String(d.text) }).catch(() => {})
          } else {
            const body: Record<string, unknown> = { title: `⇄ ${label} · ${String(d.text).slice(0, 40)}`, prompt: String(d.text), kind: 'chat' }
            if (d.key) body.integration_key = String(d.key)
            else body.profile_id = String(d.profileId)
            post<Task>('/api/tasks', body).then((task) => {
              ircTasksRef.current[ch] = task.id
              wsClient.subscribe(`task:${task.id}`)
            }).catch(() => {})
          }
        } else if (d.action === 'wake-dream' && d.id && typeof d.actionIdx === 'number' && d.actionIdx >= 0) {
          // manifest one of the dream's proposed actions (schedule/rule/agent/fact/pipeline)
          post(`/api/dreams/${d.id}/apply`, { action_index: d.actionIdx }).then(fetchDreams).catch(() => {})
        } else if (d.action === 'run-dream') {
          post('/api/dreams/run').then(fetchDreams).catch(() => {})
        } else if (d.action === 'skill-toggle' && d.id) {
          // arm/disarm an ICE protocol (auto-approve rule)
          api(`/api/rules/${d.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !!d.enable }) }).then(fetchRules).catch(() => {})
        } else if (d.action === 'skill-add' && d.pattern) {
          post('/api/rules', {
            tool_name: d.tool || 'Bash', field: (!d.tool || d.tool === 'Bash') ? 'command' : 'file_path',
            match_type: d.match || 'prefix', pattern: String(d.pattern), action: d.act || 'allow',
            priority: d.act === 'deny' ? 20 : 80, description: 'created in GRID//OS',
          }).then(fetchRules).catch(() => {})
        } else if (d.action === 'skill-delete' && d.id) {
          del(`/api/rules/${d.id}`).then(fetchRules).catch(() => {})
        } else if (d.action === 'profile-save') {
          const reload = () => get<HostProfile[]>('/api/profiles').then(setProfiles).catch(() => {})
          const body = {
            name: String(d.name || 'New Agent'), role: String(d.role || ''), description: String(d.role || ''),
            system_prompt_append: d.persona ? String(d.persona) : null, model: d.model ? String(d.model) : null,
            permission_mode: String(d.permission_mode || 'default'), max_turns: d.max_turns || null,
            inject_memory: d.inject_memory ? 1 : 0,
            // a remote-brained agent can never be the default (backend enforces too)
            is_default: d.integration_key ? false : !!d.is_default,
            integration_key: d.integration_key ? String(d.integration_key) : null,
            icon: String(d.icon || '◆'), color: String(d.color || '#34e2ff'),
            allowed_tools: Array.isArray(d.allowed_tools) ? d.allowed_tools : [],
            disallowed_tools: Array.isArray(d.disallowed_tools) ? d.disallowed_tools : [],
          }
          const req = d.id ? api(`/api/profiles/${d.id}`, { method: 'PUT', body: JSON.stringify(body) }) : post('/api/profiles', body)
          req.then(reload).catch(() => {})
        } else if (d.action === 'profile-delete' && d.id) {
          del(`/api/profiles/${d.id}`).then(() => get<HostProfile[]>('/api/profiles').then(setProfiles)).catch(() => {})
        } else if (d.action === 'pipeline-save') {
          const body = { name: String(d.name || 'Pipeline'), description: d.description ? String(d.description) : null, stages: Array.isArray(d.stages) ? d.stages : [] }
          const req = d.id ? api(`/api/pipelines/${d.id}`, { method: 'PUT', body: JSON.stringify(body) }) : post('/api/pipelines', body)
          req.then(fetchPipelines).catch(() => {})
        } else if (d.action === 'pipeline-delete' && d.id) {
          del(`/api/pipelines/${d.id}`).then(fetchPipelines).catch(() => {})
        } else if (d.action === 'run-pipeline' && d.id) {
          // launch an orchestration pipeline with optional mission input
          post(`/api/pipelines/${d.id}/run`, { input: String(d.input || '') }).then(fetchPipelines).catch(() => {})
        } else if (d.action === 'cancel-run' && d.runId) {
          post(`/api/pipelines/runs/${d.runId}/cancel`).then(fetchPipelines).catch(() => {})
        } else if (d.action === 'schedule-save') {
          const body = {
            name: String(d.name || 'Standing Order'), cron_expr: String(d.cron || '0 9 * * *'), prompt: String(d.prompt || ''),
            kind: d.kind === 'repo' ? 'repo' : 'general', repo_path: d.repo_path ? String(d.repo_path) : null,
            verify_command: d.verify_command ? String(d.verify_command) : null, profile_id: d.profile_id ? String(d.profile_id) : null,
            enabled: d.enabled !== false, overlap_policy: d.overlap === 'queue' ? 'queue' : 'skip', dream: !!d.dream,
          }
          const req = d.id ? api(`/api/schedules/${d.id}`, { method: 'PUT', body: JSON.stringify(body) }) : post('/api/schedules', body)
          req.then(fetchSchedules).catch(() => {})
        } else if (d.action === 'schedule-delete' && d.id) {
          del(`/api/schedules/${d.id}`).then(fetchSchedules).catch(() => {})
        } else if (d.action === 'schedule-toggle' && d.id) {
          // flip armed state — PUT needs the full body, so carry it back from the mapped `raw`
          const r = d.raw || {}
          api(`/api/schedules/${d.id}`, { method: 'PUT', body: JSON.stringify({ ...r, enabled: !!d.enabled }) }).then(fetchSchedules).catch(() => {})
        } else if (d.action === 'schedule-run' && d.id) {
          post(`/api/schedules/${d.id}/run_now`).then(fetchSchedules).catch(() => {})
        } else if (d.action === 'notify-save') {
          api('/api/notifications', { method: 'PUT', body: JSON.stringify({
            channel: d.channel || 'off', ntfy_topic: d.ntfy_topic || '', telegram_token: d.telegram_token || null,
            telegram_chat: d.telegram_chat || '', webhook_url: d.webhook_url || '',
            on_approval: d.on_approval !== false, on_finish: !!d.on_finish }) }).then(fetchNotify).catch(() => {})
        } else if (d.action === 'notify-test') {
          post<{ ok: boolean; detail: string }>('/api/notifications/test')
            .then((r) => iframeRef.current?.contentWindow?.postMessage({ type: 'agentos:notify-test', ok: r.ok, detail: r.detail }, '*'))
            .catch(() => iframeRef.current?.contentWindow?.postMessage({ type: 'agentos:notify-test', ok: false, detail: 'request failed' }, '*'))
        } else if (d.action === 'autostart') {
          // opt-in boot service install/remove — raises ONE Windows UAC prompt on this machine
          const ack = (ok: boolean, detail: string) =>
            iframeRef.current?.contentWindow?.postMessage({ type: 'agentos:autostart-result', ok, detail }, '*')
          post<{ ok: boolean; detail: string; status: Record<string, unknown> }>('/api/system/autostart', { enable: !!d.enable, host: d.host || '0.0.0.0' })
            .then((r) => { setAutostartSt(r.status); ack(r.ok, r.detail) })
            .catch((e) => ack(false, e instanceof Error ? e.message : 'request failed'))
        } else if (d.action === 'security-lan') {
          // flip the LAN-access override; takes effect on next restart (bind host is
          // fixed at startup). Push the fresh state back so the deck reflects it.
          post<Record<string, unknown>>('/api/system/security', { allow_insecure_lan: !!d.enable })
            .then((r) => { setNetwork(r); iframeRef.current?.contentWindow?.postMessage({ type: 'agentos:security-result', security: r }, '*') })
            .catch((e) => iframeRef.current?.contentWindow?.postMessage({ type: 'agentos:security-result', ok: false, detail: e instanceof Error ? e.message : 'request failed' }, '*'))
        } else if (d.action === 'update-now') {
          // start the self-update apply, then poll the job and stream progress into
          // the deck's update panel; a settle refetches status. No dead ends — an
          // error is pushed back with the state the deck renders RETRY + releases on.
          const push = (job: Record<string, unknown>) =>
            iframeRef.current?.contentWindow?.postMessage({ type: 'agentos:update-result', job }, '*')
          const active = ['checking', 'downloading', 'verifying', 'swapping', 'restarting']
          ;(async () => {
            let lastState = ''
            try {
              let j = await post<Record<string, unknown>>('/api/update/apply')
              push(j); lastState = String(j.state)
              const t0 = Date.now()
              while (active.includes(String(j.state)) && Date.now() - t0 < 10 * 60_000) {
                await new Promise((r) => setTimeout(r, 1000))
                try {
                  j = await get<Record<string, unknown>>('/api/update/apply')
                } catch (e) {
                  // while swapping/restarting, the server goes down under us to let
                  // the helper replace the exe — a fetch failure THERE is the expected
                  // reboot, not a flash failure. Stop polling quietly (no false error).
                  if (lastState === 'swapping' || lastState === 'restarting') return
                  throw e
                }
                push(j); lastState = String(j.state)
              }
              fetchUpdate()
            } catch (e) {
              push({ state: 'error', error: e instanceof Error ? e.message : 'apply failed' })
            }
          })()
        } else if (d.action === 'update-snooze') {
          post<Record<string, unknown>>('/api/update/snooze').then(setUpdateSt).catch(() => {})
        } else if (d.action === 'update-skip') {
          post<Record<string, unknown>>('/api/update/skip').then(setUpdateSt).catch(() => {})
        } else if (d.action === 'update-unskip') {
          post<Record<string, unknown>>('/api/update/unskip').then(setUpdateSt).catch(() => {})
        } else if (d.action === 'update-unsnooze') {
          post<Record<string, unknown>>('/api/update/unsnooze').then(setUpdateSt).catch(() => {})
        } else if (d.action === 'update-recheck') {
          post<Record<string, unknown>>('/api/update/check').then(setUpdateSt).catch(() => {})
        } else if (d.action === 'update-autocheck') {
          post<Record<string, unknown>>('/api/update/settings', { auto_check: !!d.enable }).then(setUpdateSt).catch(() => {})
        } else if (d.action === 'notify-perm') {
          requestNotifyPermission().then((perm) => iframeRef.current?.contentWindow?.postMessage({ type: 'agentos:notify-perm', permission: perm }, '*'))
        } else if (d.action === 'task-open' && d.id) {
          // drill into a board task's execution log — subscribe live + backfill the full event history
          const tid = String(d.id)
          setDetailId(tid)
          wsClient.subscribe(`task:${tid}`)
          get<Task>(`/api/tasks/${tid}`).then((t) => useStore.getState().upsertTask(t)).catch(() => {})
          get<TaskEvent[]>(`/api/tasks/${tid}/events`).then((evs) => { const st = useStore.getState(); evs.forEach((e) => st.appendEvent(e)) }).catch(() => {})
        } else if (d.action === 'task-close') {
          setDetailId('')
        } else if (d.action === 'task-followup' && d.id && d.text) {
          post(`/api/tasks/${d.id}/message`, { text: String(d.text) }).catch(() => {})
        } else if (d.action === 'task-diff' && d.id) {
          get<{ diff: string }>(`/api/tasks/${d.id}/diff`).then((r) => { iframeRef.current?.contentWindow?.postMessage({ type: 'agentos:task-diff', id: String(d.id), diff: r.diff || '' }, '*') }).catch(() => {})
        } else if (d.action === 'task-worktree' && d.id && (d.op === 'merge' || d.op === 'discard')) {
          post(`/api/tasks/${d.id}/worktree/${d.op}`).then(() => get<Task>(`/api/tasks/${d.id}`).then((t) => useStore.getState().upsertTask(t))).catch(() => {})
        }
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (e.shiftKey || e.ctrlKey)) onExit()
    }
    window.addEventListener('message', onMsg)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('message', onMsg)
      window.removeEventListener('keydown', onKey)
    }
  }, [onExit, sendData, fetchFacts, rawInteg, fetchInteg, fetchDreams, fetchRules, fetchPipelines, fetchSchedules, fetchNotify, fetchUpdate, announceUpdate, bridgeNonce])

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: '#05060c' }}>
      <iframe
        ref={iframeRef}
        src={`/cyber/index.html?osboot=${osboot}&n=${bridgeNonce}`}
        title="GRID//OS"
        allow="autoplay; fullscreen"
        onLoad={sendData}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none', display: 'block' }}
      />
      {/* jack-out lives inside GRID//OS (power button → QUIT TO PIP-OS → gridos:jackout);
          Shift/Ctrl+Esc stays as a hidden host-side safety. */}
    </div>
  )
}
