import { useCallback, useEffect, useState } from 'react'
import { api, get } from '../lib/api'
import { BOOT_VARIANTS, loadBootVariant, type BootVariant } from '../components/CyberBoot'

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
  notes: string
  has_token: boolean
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

function BootSequencePanel() {
  const [chosen, setChosen] = useState<BootVariant>(loadBootVariant())
  const select = (id: BootVariant) => {
    localStorage.setItem('agentos_cyberboot', id)
    setChosen(id)
  }
  const preview = (id: BootVariant) =>
    window.dispatchEvent(new CustomEvent('agentos:cyberboot', { detail: id }))
  return (
    <div className="wl-equip" style={{ position: 'relative', padding: '12px 14px 14px' }}>
      <span className="wl-screw wl-screw--tl" />
      <span className="wl-screw wl-screw--rusty wl-screw--tr" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 4px 4px' }}>
        <span className="wl-sectionlabel">Cyber Boot Sequence</span>
        <div className="wl-divider" style={{ flex: 1 }} />
        <span className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-dim)' }}>HACKERS · 1995</span>
      </div>
      <p className="wl-mono" style={{ margin: '0 4px 10px', fontSize: 10, color: 'var(--wl-dim)' }}>
        which boot plays when you power on the Gibson (cyber theme). preview any — the selected one is your default.
      </p>
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fill,minmax(240px,1fr))' }}>
        {BOOT_VARIANTS.map((b) => {
          const on = chosen === b.id
          return (
            <div
              key={b.id}
              className="wl-tile"
              onClick={() => select(b.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', minWidth: 0, cursor: 'pointer',
                outline: on ? '1px solid var(--wl-yellow)' : 'none',
                boxShadow: on ? 'inset 0 0 0 1px var(--wl-yellow), 0 0 12px rgba(232,193,74,.2)' : undefined,
              }}
            >
              <span className={`wl-led ${on ? 'wl-led--green' : 'wl-led--off'}`} />
              <span style={{ fontSize: 16, flex: 'none' }}>{b.glyph}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="wl-mono" style={{ fontSize: 11, fontWeight: 700, color: on ? 'var(--wl-yellow)' : 'var(--wl-cream)' }}>{b.label}</div>
                <div className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.blurb}</div>
              </div>
              <button
                type="button"
                className="wl-btn wl-btn--steel"
                style={{ fontSize: 9, padding: '4px 9px', letterSpacing: 1 }}
                onClick={(e) => { e.stopPropagation(); preview(b.id) }}
              >
                ▶ PLAY
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function IntegrationCard({ integration, onSaved }: { integration: Integration; onSaved: () => void }) {
  const [cfg, setCfg] = useState({ enabled: integration.enabled, endpoint: integration.endpoint ?? '', token: '', notes: integration.notes ?? '' })
  const [dirty, setDirty] = useState(false)
  const set = (u: Partial<typeof cfg>) => { setCfg({ ...cfg, ...u }); setDirty(true) }

  async function save() {
    await put(`/api/integrations/${integration.key}`, cfg)
    setDirty(false)
    onSaved()
  }

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
          <input className="wl-input" style={{ width: '100%' }}
                 placeholder="endpoint — e.g. http://localhost:9100"
                 value={cfg.endpoint} onChange={(e) => set({ endpoint: e.target.value })} />
          <input className="wl-input" style={{ width: '100%' }}
                 type="password"
                 placeholder={integration.has_token ? 'token — saved (type to replace)' : 'token / api key'}
                 value={cfg.token} onChange={(e) => set({ token: e.target.value })} />
          <input className="wl-input" style={{ width: '100%' }}
                 placeholder="notes" value={cfg.notes} onChange={(e) => set({ notes: e.target.value })} />
        </div>
      )}
      {dirty && (
        <div>
          <button type="button" className="wl-btn wl-btn--steel" style={{ fontSize: 10, padding: '6px 14px' }} onClick={save}>
            SAVE
          </button>
        </div>
      )}
    </div>
  )
}

export default function System() {
  const [env, setEnv] = useState<Environment | null>(null)
  const [integrations, setIntegrations] = useState<Integration[]>([])
  const [scanning, setScanning] = useState(false)

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

      <BootSequencePanel />
    </div>
  )
}
