import { useCallback, useEffect, useState } from 'react'
import { api, get, post } from '../lib/api'
import { CRT_SKINS, getCrtSkin, setCrtSkin } from '../lib/theme'

interface DetectedAgent {
  key: string
  name: string
  installed: boolean
  path: string | null
  version: string | null
  blurb: string
}

interface Check { key: string; label: string; ok: boolean; detail: string }

interface Environment {
  agentos_version: string
  sdk_version: string
  agents: DetectedAgent[]
  checklist: Check[]
}

interface Integration {
  key: string
  name: string
  icon: string
  blurb: string
  enabled: boolean
  endpoint: string
  model: string
  ssh: string
  notes: string
  transport?: string
  has_token: boolean
  last_status?: string
  last_detail?: string
  last_checked?: string
}

const put = (path: string, body: unknown) => api(path, { method: 'PUT', body: JSON.stringify(body) })

const AGENT_ICON: Record<string, string> = {
  claude: '✳', codex: '◍', gemini: '✦', openclaw: '🦞', hermes: '⚚',
  aider: '◇', ollama: '🦙', gh: '⌥', docker: '🐳', node: '⬢', python: '🐍', git: '⎇',
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

function IntegrationCard({ integration, onSaved }: { integration: Integration; onSaved: () => void }) {
  const [cfg, setCfg] = useState({ enabled: integration.enabled, endpoint: integration.endpoint ?? '', token: '', model: integration.model ?? '', ssh: integration.ssh ?? '', notes: integration.notes ?? '', transport: integration.transport ?? 'openai' })
  const isCli = cfg.transport === 'hermes-cli'
  const isAcp = cfg.transport === 'acp'
  const isSsh = isCli || isAcp  // both talk over SSH and need only the ssh destination
  // TEST/SEND become available once the saved config is usable for its transport
  const configured = isSsh ? !!integration.ssh : !!integration.endpoint
  const [dirty, setDirty] = useState(false)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null)
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [reply, setReply] = useState<{ ok: boolean; text: string } | null>(null)
  const set = (u: Partial<typeof cfg>) => { setCfg({ ...cfg, ...u }); setDirty(true) }

  async function save() {
    await put(`/api/integrations/${integration.key}`, cfg)
    setDirty(false)
    setCfg({ ...cfg, token: '' })  // token is now saved server-side; clear the field
    onSaved()
  }

  async function test() {
    setTesting(true); setResult(null)
    try { setResult(await post<{ ok: boolean; detail: string }>(`/api/integrations/${integration.key}/test`)) }
    catch { setResult({ ok: false, detail: 'test request failed' }) }
    finally { setTesting(false) }
  }

  async function send() {
    if (!prompt.trim()) return
    setSending(true); setReply(null)
    try {
      const r = await post<{ reply?: string }>(`/api/integrations/${integration.key}/dispatch`, { prompt })
      setReply({ ok: true, text: r.reply ?? '(no reply)' })
    } catch (e) {
      setReply({ ok: false, text: e instanceof Error ? e.message : 'dispatch failed' })
    } finally {
      setSending(false)
    }
  }

  // live result if just tested, else the last stored probe status
  const status = result
    ? { ok: result.ok, text: (result.ok ? '● REACHABLE' : '✗ UNREACHABLE') + (result.detail ? ' · ' + result.detail : '') }
    : integration.last_status
      ? { ok: integration.last_status === 'reachable', text: (integration.last_status === 'reachable' ? '● reachable' : '✗ unreachable') + (integration.last_detail ? ' · ' + integration.last_detail : '') }
      : null

  return (
    <div className="wl-equip" style={{ position: 'relative', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10, opacity: cfg.enabled ? 1 : 0.85 }}>
      <span className="wl-screw wl-screw--tl" />
      <span className="wl-screw wl-screw--br" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="wl-tile" style={{ width: 38, height: 38, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, color: 'var(--wl-phos-g)', textShadow: '0 0 8px var(--wl-phos-g-glow)' }}>
          {integration.icon}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontFamily: "'Chakra Petch',sans-serif", fontSize: 12, fontWeight: 700, letterSpacing: 1.5, color: 'var(--wl-cream)' }}>
            {integration.name.toUpperCase()}
          </div>
          <div className="wl-mono" style={{ fontSize: 9.5, color: 'var(--wl-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {integration.blurb}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
          <Toggle on={cfg.enabled} onClick={() => set({ enabled: !cfg.enabled })} title={cfg.enabled ? 'power off' : 'power on'} />
          <span className="wl-microlabel">{cfg.enabled ? 'ON' : 'OFF'}</span>
        </div>
      </div>
      {cfg.enabled && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* transport: how AgentOS talks to this runtime */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-faint)', letterSpacing: 1, flex: 'none' }}>LINK</span>
            <select className="wl-input" style={{ flex: 1, padding: '5px 8px' }}
                    value={cfg.transport} onChange={(e) => set({ transport: e.target.value })}>
              <option value="openai">OpenAI HTTP API (/v1/chat/completions)</option>
              <option value="hermes-cli">Hermes CLI over SSH (hermes -z)</option>
              <option value="acp">Hermes ACP over SSH (streaming · tools)</option>
            </select>
          </div>
          {isSsh ? (
            <>
              <input className="wl-input" style={{ width: '100%' }}
                     placeholder="ssh — user@host[:port] of the box Hermes runs on (e.g. redacted@203.0.113.7)"
                     value={cfg.ssh} onChange={(e) => set({ ssh: e.target.value })} />
              <div className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-dim)', lineHeight: 1.5, padding: '0 2px' }}>
                {isAcp
                  ? <>Runs <code>hermes acp</code> over SSH — a live agent session with <b>streaming replies</b>, native multi-turn memory, and tool-call visibility. Needs passwordless SSH; auth is your key.</>
                  : <>Runs <code>hermes -z "&lt;prompt&gt;"</code> over SSH and returns its reply. Needs passwordless (key-based) SSH to that box. No endpoint/token — auth is your SSH key.</>}
              </div>
            </>
          ) : (
            <>
              <input className="wl-input" style={{ width: '100%' }}
                     placeholder="endpoint — e.g. http://127.0.0.1:8642 (OpenAI-compatible base URL)"
                     value={cfg.endpoint} onChange={(e) => set({ endpoint: e.target.value })} />
              <input className="wl-input" style={{ width: '100%' }}
                     placeholder="model — gpt-4o · openai/gpt-4o · hermes-4 (blank = default)"
                     value={cfg.model} onChange={(e) => set({ model: e.target.value })} />
              <input className="wl-input" style={{ width: '100%' }}
                     type="password"
                     placeholder={integration.has_token ? 'token — saved (type to replace)' : 'token / api key'}
                     value={cfg.token} onChange={(e) => set({ token: e.target.value })} />
              <input className="wl-input" style={{ width: '100%' }}
                     placeholder="ssh (optional) — user@host[:port] to tunnel to a remote runtime"
                     value={cfg.ssh} onChange={(e) => set({ ssh: e.target.value })} />
            </>
          )}
          <input className="wl-input" style={{ width: '100%' }}
                 placeholder="notes" value={cfg.notes} onChange={(e) => set({ notes: e.target.value })} />
        </div>
      )}
      {(dirty || (cfg.enabled && configured)) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {dirty && (
            <button type="button" className="wl-btn wl-btn--steel" style={{ fontSize: 10, padding: '6px 14px' }} onClick={save}>
              SAVE
            </button>
          )}
          {cfg.enabled && !dirty && configured && (
            <button type="button" className="wl-btn wl-btn--steel" style={{ fontSize: 10, padding: '6px 14px', opacity: testing ? 0.5 : 1, pointerEvents: testing ? 'none' : 'auto' }} onClick={test}>
              {testing ? 'TESTING…' : 'TEST CONNECTION'}
            </button>
          )}
          {status && (
            <span className="wl-mono" style={{ fontSize: 9.5, color: status.ok ? 'var(--wl-phos-g)' : 'var(--wl-red-hi)', textShadow: status.ok ? '0 0 5px var(--wl-phos-g-glow)' : 'none' }}>
              {status.text}
            </span>
          )}
        </div>
      )}
      {cfg.enabled && !dirty && configured && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid rgba(255,255,255,.07)', paddingTop: 8 }}>
          <div className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-faint)', letterSpacing: 1.5 }}>SEND A PROMPT</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="wl-input" style={{ flex: 1 }} placeholder="prompt the agent…" value={prompt}
                   onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} />
            <button type="button" className="wl-btn wl-btn--steel" style={{ fontSize: 10, padding: '6px 12px', opacity: sending ? 0.5 : 1, pointerEvents: sending ? 'none' : 'auto' }} onClick={send}>
              {sending ? '…' : 'SEND'}
            </button>
          </div>
          {reply && (
            <div className="wl-mono" style={{ fontSize: 10, lineHeight: 1.55, color: reply.ok ? 'var(--wl-cream)' : 'var(--wl-red-hi)', background: 'rgba(0,0,0,.28)', border: '1px solid rgba(255,255,255,.06)', padding: '7px 9px', maxHeight: 150, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
              {reply.text}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function System() {
  const [env, setEnv] = useState<Environment | null>(null)
  const [integrations, setIntegrations] = useState<Integration[]>([])
  const [scanning, setScanning] = useState(false)
  const [crtSkin, setCrt] = useState(getCrtSkin())

  const refresh = useCallback((force = false) => {
    setScanning(true)
    get<Environment>(`/api/system/environment${force ? '?force=1' : ''}`)
      .then(setEnv)
      .finally(() => setScanning(false))
    get<Integration[]>('/api/integrations').then(setIntegrations)
  }, [])

  useEffect(() => refresh(false), [refresh])

  const installed = env?.agents.filter((a) => a.installed) ?? []
  const missing = env?.agents.filter((a) => !a.installed) ?? []

  return (
    <div className="min-h-full p-4 md:p-6" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* workshop header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div className="wl-sectionlabel">System · Setup</div>
          <div className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-faint)', marginTop: 3 }}>
            AGENTOS v{env?.agentos_version ?? '…'} · CLAUDE-AGENT-SDK {env?.sdk_version ?? '…'}
          </div>
        </div>
        <div className="wl-divider" style={{ flex: 1 }} />
        <div className="wl-btn-housing">
          <button
            type="button"
            className="wl-btn wl-btn--steel"
            style={scanning ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
            disabled={scanning}
            onClick={() => refresh(true)}
          >
            {scanning ? 'SCANNING…' : '⟳ RESCAN'}
          </button>
        </div>
      </div>

      {/* interface — CRT screen colour (scoped to comms / active-agent CRTs) */}
      <div className="wl-equip" style={{ position: 'relative', padding: '12px 14px 14px' }}>
        <span className="wl-screw wl-screw--tl" />
        <span className="wl-screw wl-screw--tr" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 4px 10px' }}>
          <span className="wl-sectionlabel">Interface</span>
          <span className="wl-mono" style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--wl-dim)' }}>
            CRT SCREENS ONLY
          </span>
        </div>
        <div className="wl-tile" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', flexWrap: 'wrap' }}>
          <span className="wl-mono" style={{ fontSize: 12, color: 'var(--wl-dim)' }}>CRT PHOSPHOR</span>
          <div style={{ display: 'flex', gap: 6 }}>
            {CRT_SKINS.map((s) => {
              const on = crtSkin === s.value
              return (
                <button
                  key={s.value || 'green'}
                  type="button"
                  className="wl-btn wl-btn--steel"
                  style={{ padding: '5px 14px', fontSize: 11, ...(on ? { boxShadow: 'inset 0 0 0 1px var(--wl-phos-g)', color: 'var(--wl-phos-g)', textShadow: '0 0 6px var(--wl-phos-g-glow)' } : {}) }}
                  onClick={() => { setCrtSkin(s.value); setCrt(s.value) }}
                >
                  {on ? '● ' : '○ '}{s.label}
                </button>
              )
            })}
          </div>
          <span className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-faint)', marginLeft: 'auto' }}>
            tints comms &amp; active-agent screens · the theme knob is on the console header
          </span>
        </div>
      </div>

      {/* boot checklist */}
      <div className="wl-equip" style={{ position: 'relative', padding: '12px 14px 14px' }}>
        <span className="wl-screw wl-screw--tl" />
        <span className="wl-screw wl-screw--tr" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 4px 10px' }}>
          <span className="wl-sectionlabel">Boot Checklist</span>
          <span className="wl-mono" style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--wl-dim)' }}>
            {env ? `${env.checklist.filter((c) => c.ok).length}/${env.checklist.length} SYSTEMS NOMINAL` : 'PROBING…'}
          </span>
        </div>
        <div style={{ display: 'grid', gap: 6, gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))' }}>
          {env?.checklist.map((c) => (
            <div key={c.key} className="wl-tile" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', minWidth: 0 }}>
              <span className={`wl-led ${c.ok ? 'wl-led--green' : 'wl-led--red'}`} />
              <span className="wl-mono" style={{ fontSize: 12, flex: 'none', color: c.ok ? 'var(--wl-phos-g)' : 'var(--wl-red-hi)', textShadow: c.ok ? '0 0 6px var(--wl-phos-g-glow)' : '0 0 6px rgba(178,86,68,.5)' }}>
                {c.ok ? '✓' : '✗'}
              </span>
              <span className="wl-mono" style={{ fontSize: 11, flex: 'none', color: 'var(--wl-cream)' }}>{c.label}</span>
              <span className="wl-mono" style={{ marginLeft: 'auto', fontSize: 9.5, color: 'var(--wl-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.detail}>
                {c.detail}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* detected on this machine */}
      <div className="wl-equip wl-rust-tr" style={{ position: 'relative', padding: '12px 14px 14px' }}>
        <span className="wl-screw wl-screw--tl" />
        <span className="wl-screw wl-screw--rusty wl-screw--br" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 4px 10px' }}>
          <span className="wl-sectionlabel">Detected On This Machine</span>
          <span className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-phos-g)', textShadow: '0 0 6px var(--wl-phos-g-glow)' }}>
            {installed.length} ONLINE
          </span>
          <div className="wl-divider" style={{ flex: 1 }} />
        </div>
        <div style={{ display: 'grid', gap: 6, gridTemplateColumns: 'repeat(auto-fill,minmax(240px,1fr))' }}>
          {installed.map((a) => (
            <div key={a.key} className="wl-tile" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', minWidth: 0 }}>
              <span className="wl-led wl-led--green" />
              <span style={{ fontSize: 15, flex: 'none', color: 'var(--wl-phos-g)', textShadow: '0 0 8px var(--wl-phos-g-glow)' }}>
                {AGENT_ICON[a.key] ?? '◆'}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="wl-mono" style={{ fontSize: 11, fontWeight: 700, color: 'var(--wl-cream)' }} title={a.blurb}>{a.name}</div>
                <div className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.path ?? ''}>
                  {a.version}
                </div>
              </div>
            </div>
          ))}
        </div>
        {missing.length > 0 && (
          <div style={{ marginTop: 8, display: 'grid', gap: 5, gridTemplateColumns: 'repeat(auto-fill,minmax(240px,1fr))' }}>
            {missing.map((a) => (
              <div key={a.key} className="wl-tile wl-tile--inset" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', opacity: 0.65, minWidth: 0 }} title={a.blurb}>
                <span className="wl-led wl-led--off" />
                <span style={{ fontSize: 13, flex: 'none', color: 'var(--wl-faint)' }}>{AGENT_ICON[a.key] ?? '◆'}</span>
                <span className="wl-mono" style={{ fontSize: 10, color: 'var(--wl-faint)' }}>{a.name}</span>
                <span className="wl-mono" style={{ marginLeft: 'auto', fontSize: 8.5, letterSpacing: 1, color: 'var(--wl-faint)' }}>NOT FOUND</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* external integrations */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="wl-sectionlabel">External Integrations</span>
          <div className="wl-divider" style={{ flex: 1 }} />
        </div>
        <p className="wl-mono" style={{ margin: '5px 0 0', fontSize: 10, color: 'var(--wl-dim)' }}>
          bridge AgentOS to other agent systems — endpoints are stored locally; the redacted slot is reserved for your future integration
        </p>
        <div style={{ marginTop: 10, display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', alignItems: 'start' }}>
          {integrations.map((integ) => (
            <IntegrationCard key={integ.key + String(integ.enabled)} integration={integ} onSaved={() => refresh(false)} />
          ))}
        </div>
      </div>

    </div>
  )
}
