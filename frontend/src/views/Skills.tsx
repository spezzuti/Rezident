import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react'
import { api, del, get, post } from '../lib/api'
import { RobotIcon } from '../components/RobotIcon'

export interface AgentProfile {
  id: string
  name: string
  description: string | null
  system_prompt_append: string | null
  allowed_tools: string[]
  disallowed_tools: string[]
  permission_mode: string
  model: string | null
  max_turns: number | null
  inject_memory: number | boolean
  is_default: number | boolean
  icon: string
  color: string
  role: string
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
  has_token?: boolean
  last_status?: string
  last_detail?: string
}

/* Wasteland-flavored dossiers so a bridged runtime reads like a real companion,
 * not a bare config row. The user's `notes` override the bio — this is the default. */
const RUNTIME_DOSSIER: Record<string, { role: string; bio: string }> = {
  hermes: {
    role: 'Off-site archivist · long memory',
    bio: 'A traveling ledger-keeper wired into the vault from afar. Remembers every caravan and every debt, and takes the questions the local crew can’t crack.',
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
    role: 'Enclave codesmith · badge pass',
    bio: 'The Enclave’s code specialist, admitted on a signed badge instead of a key — your ChatGPT sign-in IS the credential. Hand it the code work over the local terminal.',
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

function AgentCard({ profile, index, onChanged, onSwap }: { profile: AgentProfile; index: number; onChanged: () => void; onSwap: (shift: number) => void }) {
  const [p, setP] = useState({ ...profile, inject_memory: !!profile.inject_memory, is_default: !!profile.is_default })
  const [open, setOpen] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [drag, setDrag] = useState({ x: 0, y: 0, active: false })
  const set = (upd: Partial<typeof p>) => { setP({ ...p, ...upd }); setDirty(true) }

  /* pick the folder up and let it snap into a new slot on drop */
  function onFolderMouseDown(e: ReactMouseEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    if (open) return
    if ((e.target as HTMLElement).closest('input,textarea,select,button,a')) return
    e.preventDefault()
    const el = e.currentTarget
    const rect = el.getBoundingClientRect()
    const parentRect = el.parentElement ? el.parentElement.getBoundingClientRect() : rect
    const cellW = rect.width + 18
    const cellH = rect.height + 20
    const cols = Math.max(1, Math.round(parentRect.width / cellW))
    const startX = e.clientX
    const startY = e.clientY
    let dx = 0
    let dy = 0
    const onMove = (ev: MouseEvent) => {
      dx = ev.clientX - startX
      dy = ev.clientY - startY
      setDrag({ x: dx, y: dy, active: true })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const shift = Math.round(dy / cellH) * cols + Math.round(dx / cellW)
      onSwap(shift)
      setDrag({ x: 0, y: 0, active: false })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function toggleTool(list: 'allowed_tools' | 'disallowed_tools', tool: string) {
    const cur = new Set(p[list])
    cur.has(tool) ? cur.delete(tool) : cur.add(tool)
    const other: 'allowed_tools' | 'disallowed_tools' = list === 'allowed_tools' ? 'disallowed_tools' : 'allowed_tools'
    set({ [list]: [...cur], [other]: p[other].filter((t) => t !== tool) } as any)
  }

  async function save() {
    await put(`/api/profiles/${p.id}`, {
      name: p.name, description: p.description, system_prompt_append: p.system_prompt_append,
      allowed_tools: p.allowed_tools, disallowed_tools: p.disallowed_tools,
      permission_mode: p.permission_mode, model: p.model || null, max_turns: p.max_turns || null,
      inject_memory: p.inject_memory, is_default: p.is_default,
      icon: p.icon, color: p.color, role: p.role,
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
      onMouseDown={onFolderMouseDown}
      style={{
        position: 'relative', minWidth: 0,
        transform: drag.active
          ? `translate(${drag.x}px,${drag.y}px) rotate(${rot}deg) scale(1.04)`
          : `rotate(${rot}deg)`,
        cursor: drag.active ? 'grabbing' : undefined,
        zIndex: drag.active ? 20 : undefined,
        filter: drag.active ? 'drop-shadow(0 16px 22px rgba(0,0,0,.55))' : undefined,
        transition: drag.active ? 'none' : 'transform .18s ease-out',
      }}
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
              UNIT MODEL .... {MODEL_DESIGNATION[p.model ?? ''] ?? (p.model || 'SONNET 5 (STANDARD)')}<br />
              MISSIONS ...... —<br />
              STATUS ........ {p.is_default ? 'DEFAULT' : 'RESERVE'}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
          <span className="wl-hand" style={{ fontSize: 14, color: INK_RED, transform: 'rotate(-1.5deg)', minWidth: 0 }}>
            {p.description || p.role || 'no field notes on record'}
          </span>
          <span style={{ marginLeft: 'auto', flex: 'none', fontFamily: "'Chakra Petch',sans-serif", fontWeight: 700, fontSize: 12, letterSpacing: 2, padding: '3px 10px', border: '2.5px double currentColor', borderRadius: 2, opacity: 0.75, color: stampColor, transform: 'rotate(-4deg)' }}>
            {p.is_default ? 'ACTIVE' : 'RESERVE'}
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

            <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))' }}>
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
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 }}>
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Toggle on={p.inject_memory} onClick={() => set({ inject_memory: !p.inject_memory })} title="inject memory core" />
                <span style={inkLabel}>Memory Core</span>
              </div>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, borderTop: '1px dashed rgba(90,70,30,.4)', paddingTop: 8 }}>
              {!p.is_default && (
                <button type="button" className="wl-btn wl-btn--steel" style={{ fontSize: 10, padding: '6px 12px' }}
                        onClick={() => set({ is_default: true })}>
                  MAKE DEFAULT
                </button>
              )}
              {dirty && (
                <button type="button" className="wl-btn" style={{ fontSize: 10, padding: '6px 14px' }} onClick={save}>
                  SAVE FILE
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
                  onClick={async () => { if (window.confirm(`Retire ${p.name}?`)) { await del(`/api/profiles/${p.id}`); onChanged() } }}
                >
                  ✕ RETIRE
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
function RuntimeCard({ integ, index }: { integ: Integration; index: number }) {
  const [open, setOpen] = useState(false)
  const dos = RUNTIME_DOSSIER[integ.key]
  const reachable = integ.last_status !== 'unreachable' && integ.last_status !== 'error'
  const isCli = integ.transport === 'hermes-cli' || integ.transport === 'acp'  // SSH-based Hermes transports
  const CLI_NAME: Record<string, string> = { 'codex-cli': 'CODEX CLI', 'gemini-cli': 'GEMINI CLI', 'qwen-cli': 'QWEN CLI' }
  const isCodex = !!CLI_NAME[integ.transport ?? '']  // local OAuth CLI (codex/gemini/qwen sign-in)
  const CLI_AUTH: Record<string, string> = { 'codex-cli': 'ChatGPT sign-in', 'gemini-cli': 'Google sign-in', 'qwen-cli': 'qwen.ai sign-in' }
  const bio = integ.notes || dos?.bio || 'An outside machine patched into the vault over the standard wire protocol.'
  const role = dos?.role || 'Bridged runtime'
  const model = isCli ? (integ.transport === 'acp' ? 'HERMES ACP' : 'HERMES CLI') : isCodex ? CLI_NAME[integ.transport ?? ''] : (integ.model || 'remote').toUpperCase()
  const rot = [0.6, -0.5, 0.4, -0.7, 0.5, -0.3][index % 6]
  const fileNo = `LINK ${String(index + 1).padStart(3, '0')} · ${(integ.name || 'RUNTIME').toUpperCase()}`
  const statusText = reachable ? (integ.last_status === 'reachable' ? 'BRIDGED' : 'STANDBY') : 'OFFLINE'
  const statusColor = reachable ? '#3a6a7a' : '#7a3a2a'

  return (
    <div style={{ position: 'relative', minWidth: 0, transform: `rotate(${rot}deg)`, transition: 'transform .18s ease-out' }}>
      {/* steel folder tab */}
      <div
        onClick={() => setOpen(!open)}
        title={open ? 'close file' : 'open file'}
        style={{
          boxSizing: 'border-box', width: '48%', height: 17, marginBottom: -1, position: 'relative', zIndex: 2,
          background: 'linear-gradient(180deg,#9fb0bc,#8496a4)', border: '1px solid rgba(50,66,78,.55)',
          borderBottom: 'none', borderRadius: '5px 5px 0 0', display: 'flex', alignItems: 'center',
          padding: '0 10px', cursor: 'pointer',
        }}
      >
        <span className="wl-mono" style={{ fontSize: 8.5, letterSpacing: 1.3, color: '#2b3a44', whiteSpace: 'nowrap', overflow: 'hidden' }}>
          {fileNo}
        </span>
      </div>
      {/* signal-tape peeking out */}
      <span style={{ position: 'absolute', left: '54%', right: 22, top: 6, height: 12, zIndex: 0, background: 'linear-gradient(180deg,#e7edf1,#d3dde4)', border: '1px solid rgba(70,90,105,.3)', borderBottom: 'none', transform: 'rotate(.4deg)' }} />
      {/* folder body — cool steel wash */}
      <div
        onClick={() => { if (!open) setOpen(true) }}
        style={{
          position: 'relative', zIndex: 1, cursor: open ? 'default' : 'pointer',
          backgroundImage: 'radial-gradient(ellipse 60px 30px at 95% 100%,rgba(30,50,64,.16),transparent 70%),linear-gradient(170deg,#b8c6d0,#a2b3bf)',
          border: '1px solid rgba(50,66,78,.5)', borderRadius: '0 5px 4px 4px', padding: '13px 14px 12px',
          boxShadow: '0 8px 16px rgba(0,0,0,.4),0 2px 4px rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.35)',
          display: 'flex', flexDirection: 'column', gap: 10,
        }}
      >
        <div style={{ display: 'flex', gap: 13, alignItems: 'flex-start' }}>
          {/* uplink dish photo */}
          <div style={{ position: 'relative', flex: 'none', transform: 'rotate(1.5deg)' }}>
            <div style={{ width: 62, height: 68, background: '#eef2f5', padding: '4px 4px 12px', boxShadow: '0 2px 5px rgba(0,0,0,.3)' }}>
              <div style={{ width: '100%', height: '100%', background: 'radial-gradient(ellipse at 50% 40%,#1c2730,#0c1116)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, color: reachable ? 'var(--wl-blue-hi,#46c0e0)' : '#7a3a2a', textShadow: reachable ? '0 0 8px rgba(70,192,224,.5)' : 'none' }}>
                ⇄
              </div>
            </div>
            <span style={{ position: 'absolute', top: -5, left: 12, width: 38, height: 12, background: 'linear-gradient(180deg,rgba(220,232,240,.6),rgba(200,214,224,.4))', transform: 'rotate(3deg)', boxShadow: '0 1px 2px rgba(0,0,0,.18)' }} />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="wl-mono" style={{ fontSize: 13, fontWeight: 700, letterSpacing: 1, color: '#25313a' }}>{integ.name}</div>
            <div className="wl-mono" style={{ fontSize: 9.5, color: '#4a5a66', marginTop: 2 }}>{role}</div>
            <div className="wl-mono" style={{ fontSize: 9, color: '#4a5a66', marginTop: 8, lineHeight: 1.8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              RUNTIME ...... {model}<br />
              UPLINK ....... {isCli ? ('ssh ' + (integ.ssh || '—')) : isCodex ? 'local terminal' : endpointHost(integ.endpoint)}<br />
              STATUS ....... {statusText}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
          <span className="wl-hand" style={{ fontSize: 14, color: '#2a4a5a', transform: 'rotate(1deg)', minWidth: 0 }}>
            {bio}
          </span>
          <span style={{ marginLeft: 'auto', flex: 'none', fontFamily: "'Chakra Petch',sans-serif", fontWeight: 700, fontSize: 11, letterSpacing: 1.5, padding: '3px 9px', border: '2.5px double currentColor', borderRadius: 2, opacity: 0.8, color: statusColor, transform: 'rotate(-4deg)', whiteSpace: 'nowrap' }}>
            ⇄ {statusText}
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
  const [rules, setRules] = useState<Rule[]>([])
  const [newRule, setNewRule] = useState({ tool_name: 'Bash', pattern: '', action: 'allow', match_type: 'prefix' })
  /* slot → profile index; rebuilt whenever the roster size changes */
  const [order, setOrder] = useState<number[]>([])

  useEffect(() => {
    setOrder(Array.from({ length: profiles.length }, (_, i) => i))
  }, [profiles.length])

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
    get<Integration[]>('/api/integrations').then((list) => setIntegrations(list.filter((i) => i.enabled))).catch(() => {})
    get<Rule[]>('/api/rules').then(setRules)
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
        <span className="wl-sectionlabel">Personnel Files · {profiles.length} On Record{integrations.length > 0 ? ` · ${integrations.length} Bridged` : ''}</span>
        <div className="wl-divider" style={{ flex: 1 }} />
        <span className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-dim)' }}>CLEARANCE: OVERSEER</span>
        <div className="wl-btn-housing">
          <button type="button" className="wl-btn" onClick={summon}>+ RECRUIT COMPANION</button>
        </div>
      </div>

      {/* manila folders */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(290px,1fr))', gap: '20px 18px', alignItems: 'start', padding: '4px 2px' }}>
        {(order.length === profiles.length ? order : profiles.map((_, i) => i)).map((profileIdx, slot) => {
          const p = profiles[profileIdx]
          if (!p) return null
          return (
            <AgentCard
              key={p.id + String(p.is_default) + p.icon + p.color}
              profile={p}
              index={slot}
              onChanged={refresh}
              onSwap={(shift) => swapSlots(slot, shift)}
            />
          )
        })}
        {integrations.map((integ, i) => (
          <RuntimeCard key={'integ:' + integ.key} integ={integ} index={i} />
        ))}
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
                 onKeyDown={(e) => e.key === 'Enter' && addRule()} />
          <select className="wl-input" style={{ padding: '6px 8px' }} value={newRule.action}
                  onChange={(e) => setNewRule({ ...newRule, action: e.target.value })}>
            {['allow', 'deny', 'ask'].map((t) => <option key={t}>{t}</option>)}
          </select>
          <button type="button" className="wl-btn wl-btn--steel" style={{ fontSize: 10, padding: '6px 14px' }} onClick={addRule}>
            ADD
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
                      onClick={async () => { await patch(`/api/rules/${r.id}`, { enabled: !r.enabled }); refresh() }}
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
                            onClick={async () => { await del(`/api/rules/${r.id}`); refresh() }}>
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
