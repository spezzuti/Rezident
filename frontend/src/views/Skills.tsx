import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { api, del, get, getToken, post } from '../lib/api'
import { getActiveBaseUrl } from '../lib/connections'
import { lockLabel, useMasterGuard } from '../lib/master'
import { useIsMobile } from '../lib/mobile'
import { modelDesignation } from '../lib/models'
import { RobotIcon } from '../components/RobotIcon'

export interface AgentProfile {
  id: string
  name: string
  description: string | null
  system_prompt_append: string | null
  allowed_tools: string[]
  disallowed_tools: string[]
  knowledge_base_ids: string[]
  permission_mode: string
  model: string | null
  max_turns: number | null
  inject_memory: number | boolean
  is_default: number | boolean
  icon: string
  color: string
  role: string
  integration_key: string | null
  home?: { exists: boolean; files: number; bytes: number; over_budget?: boolean }
}

/* an indexed doc folder a companion can retrieve from (knowledge_bases row) */
interface KnowledgeBase {
  id: string
  name: string
  status: string
}

interface HomeFile {
  path: string
  size: number
  mtime: number
}

interface HomePreview {
  path: string
  size: number
  binary: boolean
  truncated: boolean
  content: string | null
}

/* raw fetch (not api()) — download needs the blob, not parsed JSON */
async function downloadHomeFile(profileId: string, rel: string) {
  const res = await fetch(`${getActiveBaseUrl()}/api/profiles/${profileId}/home/download?path=${encodeURIComponent(rel)}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  })
  if (!res.ok) return
  const blob = await res.blob()
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = rel.split('/').pop() || 'file'
  a.click()
  URL.revokeObjectURL(a.href)
}

const fmtBytes = (n: number) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`

const fmtAgo = (mtime: number) => {
  const d = Date.now() - mtime * 1000
  const days = Math.floor(d / 86400000)
  if (days > 0) return `${days}d ago`
  const hrs = Math.floor(d / 3600000)
  if (hrs > 0) return `${hrs}h ago`
  const mins = Math.floor(d / 60000)
  return mins > 0 ? `${mins}m ago` : 'just now'
}

interface Rule {
  id: string
  tool_name: string
  field: string | null
  match_type: string
  pattern: string
  action: string
  priority: number
  enabled: number
  description: string | null
  hit_count: number
}

interface Integration {
  key: string
  name: string
  enabled: boolean
  endpoint?: string
  model?: string
  notes?: string
  ssh?: string
  transport?: string
  kind?: string
  has_token?: boolean
  last_status?: string
  last_detail?: string
}

/* A connection only earns a personnel folder when it's agent-like: bridged/sign-in
 * runtimes are agents by nature; a key provider counts once a model is set on its
 * card — a bare key is just a connection (recruit onto it instead). */
// Which integrations stand in the cabinet as their own card: only genuinely
// NETWORKED agents (SSH bridges like Marcus; hosted APIs with a model set).
// Local conduits (Codex/sign-in CLIs, Ollama) are plumbing — staff them by
// recruiting a companion brained to the slot, not as a card of their own.
const agentLike = (i: Integration) => i.kind === 'bridge' || (i.kind === 'api' && !!(i.model || '').trim())

/* pick a folder up and let it snap into a new slot on drop — shared by manila
 * (companion) and steel (runtime) folders so the whole cabinet reorders.
 * Pointer-based so it works on TOUCH too: mouse lifts immediately (as always);
 * a finger lifts after a short LONG-PRESS, so ordinary scrolling and tap-to-open
 * stay untouched — wander during the press = a scroll, and we stand down. */
function useFolderDrag(open: boolean, onSwap: (shift: number) => void) {
  const [drag, setDrag] = useState({ x: 0, y: 0, active: false })
  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (open) return
    const touch = e.pointerType !== 'mouse'
    if (!touch && e.button !== 0) return
    if ((e.target as HTMLElement).closest('input,textarea,select,button,a')) return
    const el = e.currentTarget
    const pointerId = e.pointerId
    const rect = el.getBoundingClientRect()
    const parentRect = el.parentElement ? el.parentElement.getBoundingClientRect() : rect
    const cellW = rect.width + 18
    const cellH = rect.height + 20
    const cols = Math.max(1, Math.round(parentRect.width / cellW))
    const startX = e.clientX
    const startY = e.clientY
    let dx = 0
    let dy = 0
    let live = false // the folder is lifted
    let timer = 0

    // While lifted, veto native panning (must be a NON-passive listener; the
    // finger was still through the long-press, so no scroll has started yet).
    const blockScroll = (ev: TouchEvent) => {
      if (live) ev.preventDefault()
    }

    const lift = () => {
      live = true
      try {
        el.setPointerCapture(pointerId)
      } catch { /* capture is best-effort */ }
      try {
        navigator.vibrate?.(10) // a tick so the finger knows the folder came up
      } catch { /* no haptics — fine */ }
      setDrag({ x: dx, y: dy, active: true })
    }

    const cleanup = (commit: boolean) => {
      window.clearTimeout(timer)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('touchmove', blockScroll)
      try {
        el.releasePointerCapture(pointerId)
      } catch { /* already released */ }
      if (commit) {
        // a real drag happened — swallow the click that follows pointerup so
        // dropping a folder doesn't also flip it open
        if (Math.hypot(dx, dy) > 6) {
          window.addEventListener(
            'click',
            (ce) => { ce.stopPropagation(); ce.preventDefault() },
            { capture: true, once: true },
          )
        }
        onSwap(Math.round(dy / cellH) * cols + Math.round(dx / cellW))
      }
      setDrag({ x: 0, y: 0, active: false })
    }

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      dx = ev.clientX - startX
      dy = ev.clientY - startY
      if (!live) {
        // finger wandered before the long-press matured → it's a scroll, stand down
        if (touch && Math.hypot(dx, dy) > 12) cleanup(false)
        return
      }
      setDrag({ x: dx, y: dy, active: true })
    }
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      cleanup(live)
    }
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      cleanup(false) // the browser took the gesture (scroll) — never half-drop
    }

    if (touch) {
      timer = window.setTimeout(lift, 320)
      window.addEventListener('touchmove', blockScroll, { passive: false })
    } else {
      e.preventDefault() // mouse: immediate lift, no text selection
      lift()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }
  return { drag, onPointerDown }
}

/* the lift-and-carry visual shared by both folder types */
const dragStyle = (drag: { x: number; y: number; active: boolean }, rot: number): CSSProperties => ({
  transform: drag.active ? `translate(${drag.x}px,${drag.y}px) rotate(${rot}deg) scale(1.04)` : `rotate(${rot}deg)`,
  cursor: drag.active ? 'grabbing' : undefined,
  zIndex: drag.active ? 20 : undefined,
  filter: drag.active ? 'drop-shadow(0 16px 22px rgba(0,0,0,.55))' : undefined,
  transition: drag.active ? 'none' : 'transform .18s ease-out',
})

/* Wasteland-flavored dossiers so a bridged runtime reads like a real companion,
 * not a bare config row. The user's `notes` override the bio — this is the default. */
const RUNTIME_DOSSIER: Record<string, { role: string; bio: string }> = {
  hermes: {
    role: 'Off-site archivist · long memory',
    bio: 'A traveling ledger-keeper wired into the vault from afar. Remembers every caravan and every debt, and takes the questions the local crew can’t crack.',
  },
  marcus: {
    role: 'Independent operative · own station',
    bio: 'An old hand running his own rig out past the fence. Reached by long-range uplink — keeps his own memory, his own counsel, and answers when called.',
  },
  openclaw: {
    role: 'Net scout · remote hands',
    bio: 'A wasteland scout with a terminal jack. Sent out to crawl the old-world net, work the terminals, and haul back what it finds.',
  },
  openai: {
    role: 'Enclave mainframe · GPT',
    bio: 'A pre-war frontier intelligence reached by coded key. Vast, fast, and well-spoken — the big brain you radio when a job outguns the local crew.',
  },
  codex: {
    role: 'Local codesmith · badge pass',
    bio: 'Your on-machine code specialist, admitted on a signed badge instead of a key — your ChatGPT sign-in IS the credential. Runs right here on the local terminal; hand it the code work.',
  },
  openrouter: {
    role: 'Relay switchboard · any model',
    bio: 'A patched-together switchboard that routes your call to whichever mainframe answers — GPT, Claude, hundreds more. One key; name the line as maker/model.',
  },
  anthropic: {
    role: 'Enclave mainframe · Claude',
    bio: 'The same mind that staffs your vault crew, reached by radio instead. Claude over a coded key, for calls that go out rather than hands that work here.',
  },
  gemini: {
    role: 'Observatory array · Gemini',
    bio: 'A vast pre-war observatory that still answers hails, mostly free of charge. Long memory, quick answers — a generous ally for a vault on a budget.',
  },
  groq: {
    role: 'Racing rig · instant answers',
    bio: 'A souped-up terminal that answers before you finish asking. Open-source minds on custom hardware — the fastest wire in the wasteland.',
  },
  deepseek: {
    role: 'Deep-sea thinker · cheap rates',
    bio: 'A leviathan that thinks hard for pocket change. Send it the heavy reasoning when the vault ledger is thin.',
  },
  mistral: {
    role: 'Old-world consulate · Europe',
    bio: 'A dignified European mainframe with precise manners and many languages. A clean, neutral line when you want distance from the usual powers.',
  },
  perplexity: {
    role: 'Radio scout · live intel',
    bio: 'Doesn’t answer from dusty archives — it scans the live airwaves and reports back with sources cited. Your recon desk for the world as it is today.',
  },
  xai: {
    role: 'Pirate signal · Grok',
    bio: 'A loud unfiltered transmitter on the hill with a live feed of the wasteland’s chatter. Sharp, fast, occasionally feral. Handle accordingly.',
  },
  moonshot: {
    role: 'Night crew forge · Kimi',
    bio: 'A far-east workshop that codes through the night. Kimi K2 takes long build jobs and works them in deep context.',
  },
  zai: {
    role: 'Glyph press · GLM',
    bio: 'Zhipu’s glyph engine — a coding-strong machine that outworks its rate card. Beloved by settlements that count every cap.',
  },
  ollama: {
    role: 'Bunker machine · offline',
    bio: 'A bunker-bound rig that never phones home. Runs on your own generator — private, offline, and answerable only to you.',
  },
  qwen: {
    role: 'Eastern scholar · badge pass',
    bio: 'A far-east polymath admitted on a signed badge — your qwen.ai account, no key changes hands. Generous with its time and strong with code.',
  },
}

/* host of an endpoint URL, for the UPLINK field */
function endpointHost(url?: string): string {
  if (!url) return 'no uplink set'
  try { return new URL(url).host } catch { return url.replace(/^https?:\/\//, '').split('/')[0] || url }
}

const GATEABLE_TOOLS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch']
const ICONS = ['◆', '◉', '◈', '☿', '⚚', '⚒', 'Ω', 'Δ', 'Ψ', '☾', '✦', '⟁']
// wasteland swatches: amber, pip green, dusty teal, nuka red, vault gold, chem purple, quantum blue, olive
const COLORS = ['#e5a747', '#8fbf4d', '#5fa8a0', '#d8564a', '#f0c14b', '#b08fd0', '#46c0e0', '#a3a55b']

const put = (path: string, body: unknown) => api(path, { method: 'PUT', body: JSON.stringify(body) })
const patch = (path: string, body: unknown) => api(path, { method: 'PATCH', body: JSON.stringify(body) })

/* DB stores model ALIASES (haiku/sonnet/opus) so the SDK always resolves the
 * latest build — the dossier shows the current designation for each. */
const MODEL_DESIGNATION: Record<string, string> = {
  '': 'SONNET 5 (STANDARD)',
  haiku: 'HAIKU 4.5',
  sonnet: 'SONNET 5',
  opus: 'OPUS 4.8',
}

/* manila-folder ink */
const INK = '#3a3020'
const INK_SOFT = '#6a5a32'
const INK_RED = '#7a3a2a'

/* map a profile to one of the wasteland robot portraits */
function robotKindFor(p: AgentProfile): string | null {
  const s = `${p.name} ${p.id}`.toLowerCase()
  if (s.includes('securitron')) return 'securitron'
  if (s.includes('handy') || s.includes('mercury')) return 'handy'
  if (s.includes('eyebot') || s.includes('readonly')) return 'eyebot'
  if (s.includes('curie') || s.includes('athena')) return 'curie'
  if (s.includes('liberty') || s.includes('prime') || s.includes('vulcan')) return 'prime'
  if (s.includes('zax')) return 'zax'
  if (s.includes('robobrain')) return 'robobrain'
  if (s.includes('ed-e')) return 'ede' // hyphenated only — bare "ede" is valid uuid hex
  return null
}

const inkLabel: CSSProperties = {
  fontFamily: "'Chakra Petch','Trebuchet MS',sans-serif",
  fontSize: 8, fontWeight: 600, letterSpacing: 2, textTransform: 'uppercase', color: INK_SOFT,
}

function Toggle({ on, onClick, title }: { on: boolean; onClick: () => void; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      className={`wl-toggle${on ? ' on' : ''}`}
      style={{ border: 'none', padding: 0, flex: 'none' }}
      onClick={onClick}
    >
      <span className="wl-toggle-lever" />
    </button>
  )
}

function chipStyle(active: boolean, kind: 'block' | 'allow'): CSSProperties {
  const base: CSSProperties = {
    fontFamily: "'IBM Plex Mono',ui-monospace,monospace",
    fontSize: 9, fontWeight: 600, letterSpacing: 0.5,
    padding: '2px 7px', borderRadius: 2, cursor: 'pointer',
    background: 'transparent', border: '1px solid rgba(90,70,30,.35)', color: INK_SOFT,
  }
  if (!active) return base
  return kind === 'block'
    ? { ...base, background: 'rgba(178,86,68,.28)', border: '1px solid #b25644', color: '#6a1e12' }
    : { ...base, background: 'rgba(232,193,74,.4)', border: '1px solid #c2a13f', color: '#5a4208' }
}

function AgentCard({ profile, index, onChanged, onSwap, brains, brainLookup, bases }: { profile: AgentProfile; index: number; onChanged: () => void; onSwap: (shift: number) => void; brains: Integration[]; brainLookup: Integration[]; bases: KnowledgeBase[] }) {
  const [p, setP] = useState({ ...profile, inject_memory: !!profile.inject_memory, is_default: !!profile.is_default, knowledge_base_ids: profile.knowledge_base_ids ?? [] })
  // brained crew member: persona + memory live here, thinking happens over the
  // bound integration — dispatched one-shot, so local tools/home controls hide.
  // `remote` gates FUNCTIONALITY (integration execution) — keep it on integration_key.
  const remote = !!p.integration_key
  // resolve the brain's KIND from the full slot list (brains is enabled-only, for
  // the picker) so a disabled remote brain still labels remote — parity with the deck.
  const brain = brainLookup.find((b) => b.key === p.integration_key) ?? brains.find((b) => b.key === p.integration_key)
  const brainName = brain?.name ?? p.integration_key ?? ''
  // LABEL only: a brain on Codex/Ollama runs on THIS machine, so the ⇄ REMOTE /
  // "no local file access" framing is wrong for it — reserve that for bridge/api brains.
  const brainRemote = !!brain && (brain.kind === 'bridge' || brain.kind === 'api')
  const [open, setOpen] = useState(false)
  const [dirty, setDirty] = useState(false)
  const { locked, guard } = useMasterGuard() // profile CRUD is master-only
  // Folder reorder works on touch too now: long-press lifts the folder, a plain
  // tap still opens it, and a scroll gesture stands the drag down.
  const mobile = useIsMobile()
  const { drag, onPointerDown: onFolderPointerDown } = useFolderDrag(open, onSwap)
  const [homeOpen, setHomeOpen] = useState(false)
  const [homeInfo, setHomeInfo] = useState<{ files: HomeFile[]; count: number; bytes: number; truncated: boolean } | null>(null)
  const [preview, setPreview] = useState<HomePreview | null>(null)
  const set = (upd: Partial<typeof p>) => { setP({ ...p, ...upd }); setDirty(true) }

  async function toggleHome() {
    if (homeOpen) { setHomeOpen(false); setPreview(null); return }
    setHomeOpen(true)
    try {
      setHomeInfo(await get<{ files: HomeFile[]; count: number; bytes: number; truncated: boolean }>(`/api/profiles/${p.id}/home`))
    } catch { setHomeInfo({ files: [], count: 0, bytes: 0, truncated: false }) }
  }

  async function togglePreview(rel: string) {
    if (preview?.path === rel) { setPreview(null); return }
    try {
      setPreview(await get<HomePreview>(`/api/profiles/${p.id}/home/file?path=${encodeURIComponent(rel)}`))
    } catch { setPreview(null) }
  }

  function toggleTool(list: 'allowed_tools' | 'disallowed_tools', tool: string) {
    const cur = new Set(p[list])
    cur.has(tool) ? cur.delete(tool) : cur.add(tool)
    const other: 'allowed_tools' | 'disallowed_tools' = list === 'allowed_tools' ? 'disallowed_tools' : 'allowed_tools'
    set({ [list]: [...cur], [other]: p[other].filter((t) => t !== tool) } as any)
  }

  function toggleBase(id: string) {
    const cur = new Set(p.knowledge_base_ids ?? [])
    cur.has(id) ? cur.delete(id) : cur.add(id)
    set({ knowledge_base_ids: [...cur] })
  }

  async function save() {
    await put(`/api/profiles/${p.id}`, {
      name: p.name, description: p.description, system_prompt_append: p.system_prompt_append,
      allowed_tools: p.allowed_tools, disallowed_tools: p.disallowed_tools,
      knowledge_base_ids: p.knowledge_base_ids ?? [],
      permission_mode: p.permission_mode, model: p.model || null, max_turns: p.max_turns || null,
      inject_memory: p.inject_memory, is_default: remote ? false : p.is_default,
      icon: p.icon, color: p.color, role: p.role,
      integration_key: p.integration_key || null,
    })
    setDirty(false)
    onChanged()
  }

  const rot = [-0.7, 0.5, -0.4, 0.8, -0.6, 0.3][index % 6]
  const fileNo = `FILE ${String(index + 1).padStart(3, '0')} · ${(p.name || 'UNNAMED').toUpperCase()}`
  const stampColor = p.is_default ? '#4a7a3a' : '#6a675c'
  const robot = robotKindFor(p)

  return (
    <div
      onPointerDown={onFolderPointerDown}
      style={{ position: 'relative', minWidth: 0, ...dragStyle(drag, rot) }}
    >
      {/* folder tab */}
      <div
        onClick={() => setOpen(!open)}
        title={open ? 'close file' : 'open file'}
        style={{
          boxSizing: 'border-box', width: '46%', height: 17, marginBottom: -1, position: 'relative', zIndex: 2,
          background: 'linear-gradient(180deg,#d0b87c,#c2a768)', border: '1px solid rgba(90,70,30,.5)',
          borderBottom: 'none', borderRadius: '5px 5px 0 0', display: 'flex', alignItems: 'center',
          padding: '0 10px', cursor: 'pointer',
        }}
      >
        <span className="wl-mono" style={{ fontSize: 8.5, letterSpacing: 1.5, color: '#5a4a26', whiteSpace: 'nowrap', overflow: 'hidden' }}>
          {fileNo}
        </span>
        {/* touch has no hover to hint the folder opens — show an explicit caret */}
        {mobile && (
          <span className="wl-mono" style={{ marginLeft: 'auto', paddingLeft: 6, fontSize: 9, fontWeight: 700, color: '#5a4a26', flex: 'none' }}>
            {open ? '▾' : '▸'}
          </span>
        )}
      </div>
      {/* papers sticking out of the folder mouth */}
      <span style={{ position: 'absolute', left: '52%', right: 20, top: 5, height: 13, zIndex: 0, background: 'linear-gradient(180deg,#f9f5e9,#ece5d0)', border: '1px solid rgba(120,100,60,.25)', borderBottom: 'none', boxShadow: '0 -1px 1px rgba(0,0,0,.1)', transform: 'rotate(-.4deg)' }} />
      <span style={{ position: 'absolute', left: '56%', right: 34, top: 8, height: 11, zIndex: 0, background: 'linear-gradient(180deg,#efe9d8,#e2dac2)', border: '1px solid rgba(120,100,60,.3)', borderBottom: 'none', boxShadow: '0 -1px 1px rgba(0,0,0,.12)', transform: 'rotate(.3deg)' }} />
      {/* paperclip over folder edge + papers */}
      <span style={{ position: 'absolute', left: '62%', top: -3, width: 20, height: 46, zIndex: 3, pointerEvents: 'none', filter: 'drop-shadow(0 1px 1.5px rgba(0,0,0,.35))' }}>
        <span style={{ position: 'absolute', left: 2, right: 2, top: 0, height: 46, border: '2.6px solid #c6d0da', borderBottom: 'none', borderRadius: '8px 8px 3px 3px' }} />
        <span style={{ position: 'absolute', top: 7, left: 6, width: 8, height: 33, border: '2.2px solid #97a3ae', borderBottom: 'none', borderRadius: '4px 4px 2px 2px' }} />
      </span>
      {/* folder body */}
      <div
        onClick={() => { if (!open) setOpen(true) }}
        style={{
          position: 'relative', zIndex: 1, cursor: open ? 'default' : 'pointer',
          backgroundImage: 'radial-gradient(ellipse 60px 30px at 95% 100%,rgba(90,60,20,.18),transparent 70%),linear-gradient(170deg,#d5bd82,#c4aa6a)',
          border: '1px solid rgba(90,70,30,.5)', borderRadius: '0 5px 4px 4px', padding: '13px 14px 12px',
          boxShadow: '0 8px 16px rgba(0,0,0,.45),0 2px 4px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.3)',
          display: 'flex', flexDirection: 'column', gap: 10,
        }}
      >
        <div style={{ display: 'flex', gap: 13, alignItems: 'flex-start' }}>
          {/* polaroid — dark CRT square, taped corner */}
          <div style={{ position: 'relative', flex: 'none', transform: 'rotate(-2deg)' }}>
            <div style={{ width: 62, height: 68, background: '#f0e9d6', padding: '4px 4px 12px', boxShadow: '0 2px 5px rgba(0,0,0,.35)' }}>
              <div style={{ width: '100%', height: '100%', background: 'radial-gradient(ellipse at 50% 40%,#232c35,#10151a)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, color: 'var(--wl-phos-g)', textShadow: '0 0 8px var(--wl-phos-g-glow)' }}>
                {robot ? <RobotIcon kind={robot} /> : p.icon}
              </div>
            </div>
            <span style={{ position: 'absolute', top: -6, left: 12, width: 38, height: 13, background: 'linear-gradient(180deg,rgba(245,240,222,.55),rgba(232,224,198,.4))', transform: 'rotate(-3deg)', boxShadow: '0 1px 2px rgba(0,0,0,.2)' }} />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="wl-mono" style={{ fontSize: 13, fontWeight: 700, letterSpacing: 1, color: INK }}>{p.name}</div>
            <div className="wl-mono" style={{ fontSize: 9.5, color: INK_SOFT, marginTop: 2 }}>{p.role || 'unassigned duty'}</div>
            <div className="wl-mono" style={{ fontSize: 9, color: INK_SOFT, marginTop: 8, lineHeight: 1.8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {remote ? (
                <>
                  UNIT MODEL .... {p.model ? modelDesignation(p.model) : 'PROVIDER DEFAULT'}<br />
                  {/* the LOCAL tag is reserved for minds that truly run on this
                      metal (Ollama); cloud minds with on-machine hands (Codex)
                      carry no locality tag — they're just crew, like Claude */}
                  {brainRemote ? 'UPLINK ........ ' : 'RUNTIME ...... '}{brainName.toUpperCase()}{brainRemote ? ' · REMOTE' : brain?.kind === 'local' ? ' · LOCAL' : ''}<br />
                  STATUS ........ RESERVE
                </>
              ) : (
                <>
                  UNIT MODEL .... {MODEL_DESIGNATION[p.model ?? ''] ?? (p.model || 'SONNET 5 (STANDARD)')}<br />
                  HOME .......... {profile.home?.files ? `${profile.home.files} FILE${profile.home.files === 1 ? '' : 'S'} · ${fmtBytes(profile.home.bytes).toUpperCase()}${profile.home.over_budget ? ' ⚠' : ''}` : 'EMPTY'}<br />
                  STATUS ........ {p.is_default ? 'DEFAULT' : 'RESERVE'}
                </>
              )}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
          <span className="wl-hand" style={{ fontSize: 14, color: INK_RED, transform: 'rotate(-1.5deg)', minWidth: 0 }}>
            {p.description || p.role || 'no field notes on record'}
          </span>
          {/* the stamp is DUTY STATUS for every crew member whose hands work this
              machine (Claude and codex-brained alike) — only a network brain earns
              the ⇄ REMOTE stamp, because that's a real functional difference */}
          <span style={{ marginLeft: 'auto', flex: 'none', fontFamily: "'Chakra Petch',sans-serif", fontWeight: 700, fontSize: 12, letterSpacing: 2, padding: '3px 10px', border: '2.5px double currentColor', borderRadius: 2, opacity: 0.75, color: brainRemote ? '#3a6a7a' : stampColor, transform: 'rotate(-4deg)' }}>
            {brainRemote ? '⇄ REMOTE' : p.is_default ? 'ACTIVE' : 'RESERVE'}
          </span>
        </div>

        {/* opened dossier — the full personnel editor on a paper sheet */}
        {open && (
          <div style={{ background: 'linear-gradient(165deg,var(--wl-paper-hi) 0%,var(--wl-paper) 55%,var(--wl-paper-lo) 100%)', boxShadow: '0 3px 8px rgba(0,0,0,.3)', padding: '12px 12px 10px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={inkLabel}>Designation</div>
                <input
                  className="wl-mono"
                  style={{ width: '100%', fontSize: 12, fontWeight: 700, color: INK, background: 'transparent', border: 'none', borderBottom: '1px dashed rgba(90,70,30,.45)', outline: 'none', padding: '2px 0' }}
                  value={p.name}
                  onChange={(e) => set({ name: e.target.value })}
                />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={inkLabel}>Duty / Role</div>
                <input
                  className="wl-mono"
                  style={{ width: '100%', fontSize: 10, color: INK_SOFT, background: 'transparent', border: 'none', borderBottom: '1px dashed rgba(90,70,30,.45)', outline: 'none', padding: '3px 0' }}
                  value={p.role}
                  placeholder="role — e.g. Deep research · read-only"
                  onChange={(e) => set({ role: e.target.value })}
                />
              </div>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
              <div style={{ display: 'flex', gap: 3 }}>
                {ICONS.map((icon) => (
                  <button key={icon} type="button"
                          style={{ width: 22, height: 22, cursor: 'pointer', fontSize: 12, borderRadius: 2, background: p.icon === icon ? 'rgba(90,70,30,.2)' : 'transparent', border: p.icon === icon ? `1px solid ${INK_RED}` : '1px solid rgba(90,70,30,.3)', color: INK }}
                          onClick={() => set({ icon })}>
                    {icon}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 3 }}>
                {COLORS.map((c) => (
                  <button key={c} type="button"
                          style={{ width: 15, height: 15, cursor: 'pointer', borderRadius: '50%', background: c, border: p.color === c ? `2px solid ${INK}` : '2px solid rgba(90,70,30,.25)' }}
                          onClick={() => set({ color: c })} />
                ))}
              </div>
            </div>

            <div>
              <div style={inkLabel}>Persona — injected into its system prompt</div>
              <textarea
                className="wl-input"
                style={{ width: '100%', marginTop: 3, resize: 'vertical' }}
                rows={3}
                placeholder="Persona — who is this agent?"
                value={p.system_prompt_append ?? ''}
                onChange={(e) => set({ system_prompt_append: e.target.value })}
              />
            </div>

            {/* the brain: local Claude, or any CONNECTED integration (remote crew) */}
            <div>
              <div style={inkLabel}>Brain — where this agent thinks</div>
              <select className="wl-input" style={{ marginTop: 3, padding: '5px 8px', width: '100%' }}
                      value={p.integration_key ?? ''}
                      onChange={(e) => set({ integration_key: e.target.value || null, ...(e.target.value ? { model: '' } : { model: null }) })}>
                <option value="">LOCAL CLAUDE — full workshop access (tools, files, approvals)</option>
                {brains.map((b) => {
                  const bRemote = b.kind === 'bridge' || b.kind === 'api'
                  return <option key={b.key} value={b.key}>{b.name.toUpperCase()} — {bRemote ? 'remote uplink (chat & missions only)' : 'on this machine (works files, worktrees, verify)'}</option>
                })}
              </select>
              {remote && (
                <div className="wl-mono" style={{ fontSize: 8.5, color: INK_SOFT, marginTop: 4, lineHeight: 1.6 }}>
                  {brainRemote
                    ? <>Thinks over the {brainName} link — keeps its persona and memories, but can't touch local files or tools.</>
                    : <>Runs on {brainName}, right here on this machine — keeps its persona and memories, and works your files in the task workspace (repo missions get an isolated worktree; writes are fenced there by the CLI's own sandbox).</>}
                </div>
              )}
            </div>

            {remote && (
              <div>
                <div style={inkLabel}>Model on {brainName}</div>
                <input className="wl-input" style={{ width: '100%', marginTop: 3 }}
                       placeholder="model — e.g. moonshotai/kimi-k2 · blank = the link's default"
                       value={p.model ?? ''} onChange={(e) => set({ model: e.target.value || null })} />
              </div>
            )}

            {!remote && <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))' }}>
              <div>
                <div style={{ ...inkLabel, color: '#8a3020' }}>Blocked Tools</div>
                <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {GATEABLE_TOOLS.map((tool) => (
                    <button key={tool} type="button" style={chipStyle(p.disallowed_tools.includes(tool), 'block')}
                            onClick={() => toggleTool('disallowed_tools', tool)}>
                      {tool}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div style={{ ...inkLabel, color: '#7a5a10' }}>Auto-Approved ⚠ skips the vault door</div>
                <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {GATEABLE_TOOLS.map((tool) => (
                    <button key={tool} type="button" style={chipStyle(p.allowed_tools.includes(tool), 'allow')}
                            onClick={() => toggleTool('allowed_tools', tool)}>
                      {p.allowed_tools.includes(tool) ? '⚠ ' : ''}{tool}
                    </button>
                  ))}
                </div>
              </div>
            </div>}

            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 }}>
              {!remote && (
                <>
                  <label>
                    <div style={inkLabel}>Unit Model</div>
                    <select className="wl-input" style={{ marginTop: 3, padding: '5px 8px' }}
                            value={p.model ?? ''} onChange={(e) => set({ model: e.target.value || null })}>
                      <option value="">SONNET 5 — standard issue</option>
                      <option value="haiku">HAIKU 4.5 — cheap &amp; fast</option>
                      <option value="sonnet">SONNET 5 — balanced</option>
                      <option value="opus">OPUS 4.8 — premium</option>
                    </select>
                  </label>
                  <label>
                    <div style={inkLabel}>Permission Mode</div>
                    <select className="wl-input" style={{ marginTop: 3, padding: '5px 8px' }}
                            value={p.permission_mode} onChange={(e) => set({ permission_mode: e.target.value })}>
                      <option value="default">gate everything</option>
                      <option value="acceptEdits">file edits free</option>
                      <option value="plan">plan only</option>
                    </select>
                  </label>
                  <label>
                    <div style={inkLabel}>Max Turns</div>
                    <input type="number" className="wl-input" style={{ marginTop: 3, padding: '5px 8px', width: 70 }}
                           value={p.max_turns ?? ''} onChange={(e) => set({ max_turns: e.target.value ? Number(e.target.value) : null })} />
                  </label>
                </>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Toggle on={p.inject_memory} onClick={() => set({ inject_memory: !p.inject_memory })} title="inject memory core" />
                <span style={inkLabel}>Memory Core</span>
              </div>
            </div>

            {/* knowledge archives — RAG volumes this companion retrieves from at run time */}
            <div style={{ borderTop: '1px dashed rgba(90,70,30,.4)', paddingTop: 8 }}>
              <div style={inkLabel}>Knowledge — archives this companion can retrieve from</div>
              {bases.length === 0 ? (
                <div className="wl-mono" style={{ fontSize: 9, color: INK_SOFT, marginTop: 5, lineHeight: 1.6 }}>
                  no archives indexed yet — build one in{' '}
                  <Link to="/knowledge" style={{ color: INK_RED, textDecoration: 'underline dotted' }}>Knowledge</Link>.
                </div>
              ) : (
                <div style={{ marginTop: 5, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {bases.map((b) => {
                    const on = (p.knowledge_base_ids ?? []).includes(b.id)
                    return (
                      <button
                        key={b.id}
                        type="button"
                        style={chipStyle(on, 'allow')}
                        title={on ? `${b.name} attached — its chunks are retrieved at run time` : `attach ${b.name}`}
                        onClick={() => toggleBase(b.id)}
                      >
                        {on ? '◈ ' : ''}{b.name}{b.status !== 'ready' ? ` · ${b.status}` : ''}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {/* home directory drawer — the companion's persistent workspace (local only) */}
            {!remote && <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={inkLabel}>Home Directory — persistent workspace</div>
                <span className="wl-mono" style={{ fontSize: 9, color: INK_SOFT }}>
                  {profile.home?.files ? `${profile.home.files} files · ${fmtBytes(profile.home.bytes)}` : 'empty'}
                </span>
                {profile.home?.over_budget && (
                  <span className="wl-mono" style={{ fontSize: 8.5, letterSpacing: 1, color: '#7a2618', border: '1px solid #b25644', borderRadius: 2, padding: '0 5px' }}>⚠ OVER BUDGET</span>
                )}
                <button
                  type="button"
                  className="wl-mono"
                  style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid rgba(90,70,30,.35)', borderRadius: 2, cursor: 'pointer', fontSize: 9, letterSpacing: 1, padding: '2px 8px', color: INK_SOFT }}
                  onClick={toggleHome}
                >
                  {homeOpen ? '▴ CLOSE DRAWER' : '▸ OPEN DRAWER'}
                </button>
              </div>
              {homeOpen && (
                <div style={{ marginTop: 6, maxHeight: 150, overflowY: 'auto', border: '1px dashed rgba(90,70,30,.4)', borderRadius: 2, padding: '6px 8px' }}>
                  {homeInfo === null ? (
                    <div className="wl-mono" style={{ fontSize: 9, color: INK_SOFT }}>reading drawer…</div>
                  ) : homeInfo.files.length === 0 ? (
                    <div className="wl-mono" style={{ fontSize: 9, color: INK_SOFT }}>nothing filed yet — this companion hasn't kept any working files.</div>
                  ) : (
                    <>
                      {homeInfo.files.map((f) => (
                        <div key={f.path} style={{ minWidth: 0 }}>
                          <div className="wl-mono" style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 9.5, color: INK, lineHeight: 1.9, minWidth: 0 }}>
                            <button
                              type="button"
                              title="preview"
                              className="wl-mono"
                              style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', fontSize: 9.5, color: preview?.path === f.path ? INK_RED : INK, textAlign: 'left', textDecoration: 'underline dotted rgba(90,70,30,.5)' }}
                              onClick={() => togglePreview(f.path)}
                            >
                              {f.path}
                            </button>
                            <span style={{ marginLeft: 'auto', flex: 'none', color: INK_SOFT }}>{fmtBytes(f.size)}</span>
                            <span style={{ flex: 'none', width: 62, textAlign: 'right', color: INK_SOFT }}>{fmtAgo(f.mtime)}</span>
                            <button
                              type="button"
                              title="download"
                              style={{ flex: 'none', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', fontSize: 10, color: INK_SOFT }}
                              onClick={() => downloadHomeFile(p.id, f.path)}
                            >
                              ⬇
                            </button>
                          </div>
                          {preview?.path === f.path && (
                            <div style={{ margin: '3px 0 6px', border: '1px solid rgba(90,70,30,.4)', borderRadius: 2, background: 'rgba(255,252,240,.5)', padding: '6px 8px' }}>
                              {preview.binary ? (
                                <div className="wl-mono" style={{ fontSize: 9, color: INK_SOFT }}>binary file ({fmtBytes(preview.size)}) — use ⬇ to download.</div>
                              ) : (
                                <>
                                  <pre className="wl-mono" style={{ margin: 0, maxHeight: 130, overflow: 'auto', fontSize: 9, lineHeight: 1.5, color: INK, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{preview.content}</pre>
                                  {preview.truncated && (
                                    <div className="wl-mono" style={{ fontSize: 8.5, color: INK_SOFT, marginTop: 3 }}>… preview truncated — ⬇ for the full file.</div>
                                  )}
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                      {homeInfo.truncated && (
                        <div className="wl-mono" style={{ fontSize: 8.5, color: INK_SOFT, marginTop: 3 }}>… drawer holds more — showing the {homeInfo.files.length} newest.</div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>}

            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, borderTop: '1px dashed rgba(90,70,30,.4)', paddingTop: 8 }}>
              {!p.is_default && !remote && (
                <button type="button" className="wl-btn wl-btn--steel" style={{ fontSize: 10, padding: '6px 12px' }}
                        onClick={() => set({ is_default: true })}>
                  MAKE DEFAULT
                </button>
              )}
              {dirty && (
                <button type="button" className="wl-btn" style={{ fontSize: 10, padding: '6px 14px', opacity: locked ? 0.55 : 1 }} onClick={guard(save)}>
                  {lockLabel(locked, 'SAVE FILE')}
                </button>
              )}
              <button
                type="button"
                className="wl-mono"
                style={{ marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 9, letterSpacing: 1, color: INK_SOFT }}
                onClick={() => setOpen(false)}
              >
                ▴ CLOSE FILE
              </button>
              {!p.is_default && (
                <button
                  type="button"
                  className="wl-mono"
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 9, letterSpacing: 1, color: INK_RED }}
                  onClick={guard(async () => {
                    const homeNote = profile.home?.files
                      ? ` Its home directory (${profile.home.files} file${profile.home.files === 1 ? '' : 's'}, ${fmtBytes(profile.home.bytes)}) is deleted with it.`
                      : ''
                    if (window.confirm(`Retire ${p.name}?${homeNote}`)) { await del(`/api/profiles/${p.id}`); onChanged() }
                  })}
                >
                  {lockLabel(locked, '✕ RETIRE')}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/* A bridged external runtime, shown as a steel-tabbed field file alongside the
 * manila personnel folders. Read-only here — wiring lives in Settings › Integrations. */
function RuntimeCard({ integ, index, onSwap }: { integ: Integration; index: number; onSwap: (shift: number) => void }) {
  const [open, setOpen] = useState(false)
  const mobile = useIsMobile()
  const { drag, onPointerDown } = useFolderDrag(open, onSwap)
  const dos = RUNTIME_DOSSIER[integ.key]
  const reachable = integ.last_status !== 'unreachable' && integ.last_status !== 'error'
  const isCli = integ.transport === 'hermes-cli' || integ.transport === 'acp'  // SSH-based Hermes transports
  const CLI_NAME: Record<string, string> = { 'codex-cli': 'CODEX CLI', 'gemini-cli': 'GEMINI CLI', 'qwen-cli': 'QWEN CLI' }
  const isCodex = !!CLI_NAME[integ.transport ?? '']  // local OAuth CLI (codex/gemini/qwen sign-in)
  // Codex (oauth) and Ollama (local) run on THIS machine — dress them as local
  // runtimes, not bridged uplinks. Bridge/api kinds stay remote-framed.
  const isLocalKind = integ.kind === 'oauth' || integ.kind === 'local'
  const CLI_AUTH: Record<string, string> = { 'codex-cli': 'ChatGPT sign-in', 'gemini-cli': 'Google sign-in', 'qwen-cli': 'qwen.ai sign-in' }
  // Folder costume. Local specialists (Codex, Ollama, the sign-in CLIs) are EQUAL
  // companions that happen to run on this machine — they wear their own sage-green
  // field folder, distinct from both the manila personas and the steel remote
  // uplinks, so you still know which is which at a glance. Remote bridges keep steel.
  const C = isLocalKind
    ? {
        tab: 'linear-gradient(180deg,#b7c48d,#a5b377)', tabBorder: 'rgba(72,86,42,.55)', ink: '#2e3a22',
        tape: 'linear-gradient(180deg,#eef2df,#e0e6ca)', tapeBorder: 'rgba(95,110,60,.3)',
        body: 'radial-gradient(ellipse 60px 30px at 95% 100%,rgba(60,80,25,.18),transparent 70%),linear-gradient(170deg,#c3cf97,#b0be7f)',
        bodyBorder: 'rgba(72,86,42,.5)', sub: '#4a5632', hand: '#3a4a26', paneInk: '#42522e',
        glyph: '❯', glyphColor: reachable ? '#8fe08f' : '#7a3a2a', glyphGlow: reachable ? '0 0 8px rgba(120,224,120,.5)' : 'none',
        okColor: '#4a6a34',
      }
    : {
        tab: 'linear-gradient(180deg,#9fb0bc,#8496a4)', tabBorder: 'rgba(50,66,78,.55)', ink: '#2b3a44',
        tape: 'linear-gradient(180deg,#e7edf1,#d3dde4)', tapeBorder: 'rgba(70,90,105,.3)',
        body: 'radial-gradient(ellipse 60px 30px at 95% 100%,rgba(30,50,64,.16),transparent 70%),linear-gradient(170deg,#b8c6d0,#a2b3bf)',
        bodyBorder: 'rgba(50,66,78,.5)', sub: '#4a5a66', hand: '#2a4a5a', paneInk: '#3a5a6a',
        glyph: '⇄', glyphColor: reachable ? 'var(--wl-blue-hi,#46c0e0)' : '#7a3a2a', glyphGlow: reachable ? '0 0 8px rgba(70,192,224,.5)' : 'none',
        okColor: '#3a6a7a',
      }
  const bio = integ.notes || dos?.bio || (isLocalKind ? 'A machine that runs right here on your own metal — no wire out.' : 'An outside machine patched into the vault over the standard wire protocol.')
  const role = dos?.role || (isLocalKind ? 'Resident specialist' : 'Bridged runtime')
  const model = isCli ? (integ.transport === 'acp' ? 'HERMES ACP' : 'HERMES CLI') : isCodex ? CLI_NAME[integ.transport ?? ''] : (integ.model || (isLocalKind ? 'local' : 'remote')).toUpperCase()
  const rot = [0.6, -0.5, 0.4, -0.7, 0.5, -0.3][index % 6]
  const fileNo = `${isLocalKind ? 'SPEC' : 'LINK'} ${String(index + 1).padStart(3, '0')} · ${(integ.name || 'RUNTIME').toUpperCase()}`
  const statusText = reachable ? (integ.last_status === 'reachable' ? (isLocalKind ? 'LOCAL' : 'BRIDGED') : 'STANDBY') : 'OFFLINE'
  const statusColor = reachable ? C.okColor : '#7a3a2a'
  const stampGlyph = isLocalKind ? '▣' : '⇄'  // local runs on-metal; no bridge arrow

  return (
    <div onPointerDown={onPointerDown} style={{ position: 'relative', minWidth: 0, ...dragStyle(drag, rot) }}>
      {/* steel folder tab */}
      <div
        onClick={() => setOpen(!open)}
        title={open ? 'close file' : 'open file'}
        style={{
          boxSizing: 'border-box', width: '48%', height: 17, marginBottom: -1, position: 'relative', zIndex: 2,
          background: C.tab, border: `1px solid ${C.tabBorder}`,
          borderBottom: 'none', borderRadius: '5px 5px 0 0', display: 'flex', alignItems: 'center',
          padding: '0 10px', cursor: 'pointer',
        }}
      >
        <span className="wl-mono" style={{ fontSize: 8.5, letterSpacing: 1.3, color: C.ink, whiteSpace: 'nowrap', overflow: 'hidden' }}>
          {fileNo}
        </span>
        {/* touch has no hover to hint the folder opens — show an explicit caret */}
        {mobile && (
          <span className="wl-mono" style={{ marginLeft: 'auto', paddingLeft: 6, fontSize: 9, fontWeight: 700, color: C.ink, flex: 'none' }}>
            {open ? '▾' : '▸'}
          </span>
        )}
      </div>
      {/* signal-tape peeking out */}
      <span style={{ position: 'absolute', left: '54%', right: 22, top: 6, height: 12, zIndex: 0, background: C.tape, border: `1px solid ${C.tapeBorder}`, borderBottom: 'none', transform: 'rotate(.4deg)' }} />
      {/* folder body — cool steel wash */}
      <div
        onClick={() => { if (!open) setOpen(true) }}
        style={{
          position: 'relative', zIndex: 1, cursor: open ? 'default' : 'pointer',
          backgroundImage: C.body,
          border: `1px solid ${C.bodyBorder}`, borderRadius: '0 5px 4px 4px', padding: '13px 14px 12px',
          boxShadow: '0 8px 16px rgba(0,0,0,.4),0 2px 4px rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.35)',
          display: 'flex', flexDirection: 'column', gap: 10,
        }}
      >
        <div style={{ display: 'flex', gap: 13, alignItems: 'flex-start' }}>
          {/* uplink dish photo */}
          <div style={{ position: 'relative', flex: 'none', transform: 'rotate(1.5deg)' }}>
            <div style={{ width: 62, height: 68, background: '#eef2f5', padding: '4px 4px 12px', boxShadow: '0 2px 5px rgba(0,0,0,.3)' }}>
              <div style={{ width: '100%', height: '100%', background: 'radial-gradient(ellipse at 50% 40%,#1c2730,#0c1116)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, color: C.glyphColor, textShadow: C.glyphGlow }}>
                {C.glyph}
              </div>
            </div>
            <span style={{ position: 'absolute', top: -5, left: 12, width: 38, height: 12, background: 'linear-gradient(180deg,rgba(220,232,240,.6),rgba(200,214,224,.4))', transform: 'rotate(3deg)', boxShadow: '0 1px 2px rgba(0,0,0,.18)' }} />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="wl-mono" style={{ fontSize: 13, fontWeight: 700, letterSpacing: 1, color: C.ink }}>{integ.name}</div>
            <div className="wl-mono" style={{ fontSize: 9.5, color: C.sub, marginTop: 2 }}>{role}</div>
            <div className="wl-mono" style={{ fontSize: 9, color: C.sub, marginTop: 8, lineHeight: 1.8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              RUNTIME ...... {model}<br />
              UPLINK ....... {isCli ? ('ssh ' + (integ.ssh || '—')) : isCodex ? 'local terminal' : endpointHost(integ.endpoint)}<br />
              STATUS ....... {statusText}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
          <span className="wl-hand" style={{ fontSize: 14, color: C.hand, transform: 'rotate(1deg)', minWidth: 0 }}>
            {bio}
          </span>
          <span style={{ marginLeft: 'auto', flex: 'none', fontFamily: "'Chakra Petch',sans-serif", fontWeight: 700, fontSize: 11, letterSpacing: 1.5, padding: '3px 9px', border: '2.5px double currentColor', borderRadius: 2, opacity: 0.8, color: statusColor, transform: 'rotate(-4deg)', whiteSpace: 'nowrap' }}>
            {stampGlyph} {statusText}
          </span>
        </div>

        {open && (
          <div style={{ background: 'linear-gradient(165deg,#f2f6f8 0%,#e6edf1 55%,#d7e0e5 100%)', boxShadow: '0 3px 8px rgba(0,0,0,.28)', padding: '12px 12px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div>
              <div style={{ ...inkLabel, color: '#3a5a6a' }}>{isCli || isCodex ? 'Link' : 'Uplink Endpoint'}</div>
              <div className="wl-mono" style={{ fontSize: 10, color: '#2a3a44', marginTop: 3, wordBreak: 'break-all' }}>{isCli ? `hermes over SSH · ${integ.ssh || 'no host set'}` : isCodex ? `${(CLI_NAME[integ.transport ?? ''] || '').toLowerCase()} · local` : (integ.endpoint || 'not configured')}</div>
            </div>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <div>
                <div style={{ ...inkLabel, color: '#3a5a6a' }}>{isCli ? 'Runtime' : 'Model'}</div>
                <div className="wl-mono" style={{ fontSize: 10, color: '#2a3a44', marginTop: 3 }}>{isCli ? (integ.transport === 'acp' ? 'Hermes ACP' : 'Hermes CLI') : (integ.model || (isCodex ? 'CLI default' : 'server default'))}</div>
              </div>
              <div>
                <div style={{ ...inkLabel, color: '#3a5a6a' }}>Auth</div>
                <div className="wl-mono" style={{ fontSize: 10, color: '#2a3a44', marginTop: 3 }}>{isCli ? 'SSH key' : isCodex ? (CLI_AUTH[integ.transport ?? ''] || 'vendor sign-in') : (integ.has_token ? 'key on file' : 'no key')}</div>
              </div>
            </div>
            {integ.last_detail && (
              <div>
                <div style={{ ...inkLabel, color: '#3a5a6a' }}>Last Check</div>
                <div className="wl-mono" style={{ fontSize: 9.5, color: reachable ? '#2a5a3a' : '#7a3a2a', marginTop: 3 }}>{integ.last_detail}</div>
              </div>
            )}
            <div style={{ borderTop: '1px dashed rgba(50,80,100,.4)', paddingTop: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="wl-mono" style={{ fontSize: 9, color: '#4a5a66' }}>tune the uplink in Settings › Integrations</span>
              <button type="button" className="wl-mono" style={{ marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 9, letterSpacing: 1, color: '#4a5a66' }} onClick={() => setOpen(false)}>
                ▴ CLOSE FILE
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default function Skills() {
  const [profiles, setProfiles] = useState<AgentProfile[]>([])
  const [integrations, setIntegrations] = useState<Integration[]>([])
  // full slot list incl. disabled — used ONLY to resolve a set brain's kind (a
  // profile brained to a since-disabled remote slot must still read remote).
  const [allIntegrations, setAllIntegrations] = useState<Integration[]>([])
  const [rules, setRules] = useState<Rule[]>([])
  const [bases, setBases] = useState<KnowledgeBase[]>([])
  const [newRule, setNewRule] = useState({ tool_name: 'Bash', pattern: '', action: 'allow', match_type: 'prefix' })
  const { locked, guard } = useMasterGuard() // recruit + rules cabinet are master-only

  /* the whole cabinet in one drag order: manila companion folders + the steel
     runtime files that qualify as agents (bare key connections stay in Settings) */
  const runtimes = integrations.filter(agentLike)
  const items: ({ type: 'profile'; p: AgentProfile } | { type: 'runtime'; integ: Integration })[] = [
    ...profiles.map((p) => ({ type: 'profile' as const, p })),
    ...runtimes.map((integ) => ({ type: 'runtime' as const, integ })),
  ]

  /* slot → item index; rebuilt whenever the roster size changes */
  const [order, setOrder] = useState<number[]>([])

  useEffect(() => {
    setOrder(Array.from({ length: items.length }, (_, i) => i))
  }, [items.length])

  const swapSlots = useCallback((pos: number, shift: number) => {
    setOrder((prev) => {
      const target = Math.min(Math.max(pos + shift, 0), prev.length - 1)
      if (target === pos || prev.length === 0) return prev
      const next = [...prev]
      const tmp = next[pos]
      next[pos] = next[target]
      next[target] = tmp
      return next
    })
  }, [])

  const refresh = useCallback(() => {
    get<AgentProfile[]>('/api/profiles').then(setProfiles)
    get<Integration[]>('/api/integrations').then((list) => { setAllIntegrations(list); setIntegrations(list.filter((i) => i.enabled)) }).catch(() => {})
    // rules are master-only — a handset 403s here; degrade to an empty cabinet
    get<Rule[]>('/api/rules').then(setRules).catch(() => {})
    get<KnowledgeBase[]>('/api/knowledge').then(setBases).catch(() => {})
  }, [])

  useEffect(refresh, [refresh])

  async function summon() {
    await post('/api/profiles', {
      name: 'New Agent', role: 'describe this agent', allowed_tools: [], disallowed_tools: [],
      icon: ICONS[Math.floor(Math.random() * ICONS.length)],
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
    })
    refresh()
  }

  async function addRule() {
    if (!newRule.pattern.trim()) return
    await post('/api/rules', {
      ...newRule,
      field: newRule.tool_name === 'Bash' ? 'command' : 'file_path',
      priority: newRule.action === 'deny' ? 20 : 80,
      description: 'created in Pantheon view',
    })
    setNewRule({ ...newRule, pattern: '' })
    refresh()
  }

  const actionColor = (action: string) =>
    action === 'allow' ? 'var(--wl-phos-g)' : action === 'deny' ? 'var(--wl-red-hi)' : 'var(--wl-yellow)'

  return (
    <div className="min-h-full p-4 md:p-6" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* personnel header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span className="wl-sectionlabel">Personnel Files · {profiles.length} On Record{runtimes.length > 0 ? ` · ${runtimes.length} Linked` : ''}</span>
        <div className="wl-divider" style={{ flex: 1 }} />
        <span className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-dim)' }}>CLEARANCE: OVERSEER</span>
        <div className="wl-btn-housing">
          <button type="button" className="wl-btn" style={{ opacity: locked ? 0.55 : 1 }} onClick={guard(summon)}>
            {lockLabel(locked, '+ RECRUIT COMPANION')}
          </button>
        </div>
      </div>

      {/* the filing cabinet — every folder drags, manila and steel alike */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(290px,1fr))', gap: '20px 18px', alignItems: 'start', padding: '4px 2px' }}>
        {(order.length === items.length ? order : items.map((_, i) => i)).map((itemIdx, slot) => {
          const it = items[itemIdx]
          if (!it) return null
          if (it.type === 'runtime') {
            return (
              <RuntimeCard
                key={'integ:' + it.integ.key}
                integ={it.integ}
                index={slot}
                onSwap={(shift) => swapSlots(slot, shift)}
              />
            )
          }
          const p = it.p
          return (
            <AgentCard
              key={p.id + String(p.is_default) + p.icon + p.color + (p.integration_key ?? '')}
              profile={p}
              index={slot}
              brains={integrations}
              brainLookup={allIntegrations}
              bases={bases}
              onChanged={refresh}
              onSwap={(shift) => swapSlots(slot, shift)}
            />
          )
        })}
      </div>

      {/* tool firewall */}
      <div className="wl-equip wl-rust-tr" style={{ position: 'relative', padding: '12px 14px 14px', width: '100%', boxSizing: 'border-box' }}>
        <span className="wl-screw wl-screw--tl" />
        <span className="wl-screw wl-screw--rusty wl-screw--br" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 4px' }}>
          <span className="wl-sectionlabel">Tool Firewall</span>
          <span className="wl-mono" style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--wl-dim)' }}>
            FIRST MATCH BY PRIORITY WINS · <span style={{ color: 'var(--wl-phos-g)' }}>ALLOW</span> RUNS SILENTLY · <span style={{ color: 'var(--wl-red-hi)' }}>DENY</span> BLOCKS SILENTLY · NO MATCH ASKS YOU
          </span>
        </div>

        {/* add-rule bench */}
        <div className="wl-tile--inset wl-tile" style={{ marginTop: 10, padding: '10px 12px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <select className="wl-input" style={{ padding: '6px 8px' }} value={newRule.tool_name}
                  onChange={(e) => setNewRule({ ...newRule, tool_name: e.target.value })}>
            {['Bash', 'Write', 'Edit', '*'].map((t) => <option key={t}>{t}</option>)}
          </select>
          <select className="wl-input" style={{ padding: '6px 8px' }} value={newRule.match_type}
                  onChange={(e) => setNewRule({ ...newRule, match_type: e.target.value })}>
            {['prefix', 'regex', 'glob'].map((t) => <option key={t}>{t}</option>)}
          </select>
          <input className="wl-input" style={{ flex: 1, minWidth: 180, padding: '6px 10px' }}
                 placeholder="pattern — e.g. git commit" value={newRule.pattern}
                 onChange={(e) => setNewRule({ ...newRule, pattern: e.target.value })}
                 onKeyDown={(e) => e.key === 'Enter' && guard(addRule)()} />
          <select className="wl-input" style={{ padding: '6px 8px' }} value={newRule.action}
                  onChange={(e) => setNewRule({ ...newRule, action: e.target.value })}>
            {['allow', 'deny', 'ask'].map((t) => <option key={t}>{t}</option>)}
          </select>
          <button type="button" className="wl-btn wl-btn--steel" style={{ fontSize: 10, padding: '6px 14px', opacity: locked ? 0.55 : 1 }} onClick={guard(addRule)}>
            {lockLabel(locked, 'ADD')}
          </button>
        </div>

        {rules.length > 0 && (
          <table className="wl-table" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th style={{ width: 34 }}>Arm</th>
                <th style={{ width: 70 }}>Action</th>
                <th style={{ width: 80 }}>Tool</th>
                <th style={{ width: 70 }}>Match</th>
                <th>Pattern</th>
                <th style={{ width: 48 }}>Pri</th>
                <th style={{ width: 52 }}>Hits</th>
                <th style={{ width: 34 }} />
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} style={!r.enabled ? { opacity: 0.4 } : undefined}>
                  <td>
                    <Toggle
                      on={!!r.enabled}
                      title={r.enabled ? 'disarm' : 'arm'}
                      onClick={guard(async () => { await patch(`/api/rules/${r.id}`, { enabled: !r.enabled }); refresh() })}
                    />
                  </td>
                  <td style={{ fontWeight: 700, textTransform: 'uppercase', color: actionColor(r.action) }}>{r.action}</td>
                  <td style={{ color: 'var(--wl-blue-hi)' }}>{r.tool_name}</td>
                  <td style={{ color: 'var(--wl-dim)' }}>{r.match_type}</td>
                  <td style={{ maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--wl-cream)' }} title={r.pattern}>{r.pattern}</td>
                  <td style={{ color: 'var(--wl-dim)' }} title="priority">p{r.priority}</td>
                  <td style={{ color: 'var(--wl-dim)' }} title="hits">{r.hit_count}×</td>
                  <td>
                    <button type="button"
                            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--wl-faint)', fontFamily: 'inherit' }}
                            onMouseOver={(e) => { e.currentTarget.style.color = 'var(--wl-red-hi)' }}
                            onMouseOut={(e) => { e.currentTarget.style.color = 'var(--wl-faint)' }}
                            onClick={guard(async () => { await del(`/api/rules/${r.id}`); refresh() })}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
