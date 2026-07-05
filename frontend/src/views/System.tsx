import { useCallback, useEffect, useState } from 'react'
import { api, get } from '../lib/api'

const TEAL = '#2dd4bf'

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
    <div className={`glass hud-corner p-4 ${cfg.enabled ? '' : 'opacity-80'}`}
         style={cfg.enabled ? { boxShadow: `0 0 22px ${TEAL}33` } : undefined}>
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg border text-xl"
              style={{ color: TEAL, borderColor: `${TEAL}55`, background: `${TEAL}11` }}>
          {integration.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm font-bold" style={{ color: TEAL }}>{integration.name}</div>
          <div className="truncate text-[11px] text-ink-dim">{integration.blurb}</div>
        </div>
        <button
          className={`h-5 w-9 shrink-0 rounded-full transition-colors ${cfg.enabled ? '' : 'bg-panel-2'}`}
          style={cfg.enabled ? { background: `${TEAL}aa` } : undefined}
          onClick={() => set({ enabled: !cfg.enabled })}
        >
          <span className={`block h-4 w-4 rounded-full bg-white transition-transform ${cfg.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
        </button>
      </div>
      {cfg.enabled && (
        <div className="mt-3 space-y-2">
          <input className="w-full rounded-md border border-edge bg-input px-2.5 py-1.5 font-mono text-xs outline-none focus:border-accent/50"
                 placeholder="endpoint — e.g. http://localhost:9100"
                 value={cfg.endpoint} onChange={(e) => set({ endpoint: e.target.value })} />
          <input className="w-full rounded-md border border-edge bg-input px-2.5 py-1.5 font-mono text-xs outline-none focus:border-accent/50"
                 type="password"
                 placeholder={integration.has_token ? 'token — saved (type to replace)' : 'token / api key'}
                 value={cfg.token} onChange={(e) => set({ token: e.target.value })} />
          <input className="w-full rounded-md border border-edge bg-input px-2.5 py-1.5 font-mono text-xs outline-none focus:border-accent/50"
                 placeholder="notes" value={cfg.notes} onChange={(e) => set({ notes: e.target.value })} />
        </div>
      )}
      {dirty && (
        <button className="mt-3 rounded-md px-3 py-1 font-mono text-[10px] font-bold uppercase text-bg"
                style={{ background: TEAL }} onClick={save}>
          save
        </button>
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
    <div className="min-h-full p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="hud-label !text-xs" style={{ color: TEAL }}>System · Setup</h1>
          <div className="mt-0.5 font-mono text-[10px] text-ink-dimmer">
            AgentOS v{env?.agentos_version ?? '…'} · claude-agent-sdk {env?.sdk_version ?? '…'}
          </div>
        </div>
        <button
          className="hud-corner glass-bright px-4 py-2 font-mono text-xs font-bold uppercase tracking-widest transition-all"
          style={{ color: TEAL }}
          disabled={scanning}
          onClick={() => refresh(true)}
        >
          {scanning ? 'scanning…' : '⟳ rescan machine'}
        </button>
      </div>

      {/* setup checklist */}
      <div className="mt-4 flex items-center gap-3">
        <h2 className="hud-label">Boot checklist</h2>
        <hr className="neon-divider flex-1" />
      </div>
      <div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {env?.checklist.map((c) => (
          <div key={c.key} className="glass flex items-center gap-3 !rounded-lg px-3 py-2.5">
            <span className={`font-mono text-lg ${c.ok ? 'text-ok' : 'text-err'}`}
                  style={{ textShadow: c.ok ? '0 0 12px rgba(74,222,128,0.6)' : '0 0 12px rgba(248,113,113,0.6)' }}>
              {c.ok ? '✓' : '✗'}
            </span>
            <div className="min-w-0">
              <div className="text-xs font-semibold text-ink-2">{c.label}</div>
              <div className="truncate font-mono text-[10px] text-ink-dim">{c.detail}</div>
            </div>
          </div>
        ))}
      </div>

      {/* detected agents */}
      <div className="mt-6 flex items-center gap-3">
        <h2 className="hud-label">Detected on this machine</h2>
        <span className="rounded-full bg-panel-2 px-2 font-mono text-[11px]" style={{ color: TEAL }}>
          {installed.length}
        </span>
        <hr className="neon-divider flex-1" />
      </div>
      <div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {installed.map((a) => (
          <div key={a.key} className="glass hud-corner px-3 py-2.5"
               style={{ boxShadow: `0 0 16px ${TEAL}22` }}>
            <div className="flex items-center gap-2.5">
              <span className="text-lg" style={{ color: TEAL, textShadow: `0 0 12px ${TEAL}` }}>
                {AGENT_ICON[a.key] ?? '◆'}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-xs font-bold text-ink">{a.name}</span>
                  <span className="rounded border px-1 font-mono text-[9px] font-bold uppercase tracking-widest"
                        style={{ color: TEAL, borderColor: `${TEAL}55` }}>online</span>
                </div>
                <div className="truncate font-mono text-[10px] text-ink-dim" title={a.path ?? ''}>{a.version}</div>
              </div>
            </div>
            <div className="mt-1 truncate font-mono text-[9px] text-ink-dimmer">{a.blurb}</div>
          </div>
        ))}
      </div>
      {missing.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {missing.map((a) => (
            <span key={a.key} className="rounded-full border border-edge px-2.5 py-1 font-mono text-[10px] text-ink-dimmer" title={a.blurb}>
              {AGENT_ICON[a.key] ?? '◆'} {a.name} · not found
            </span>
          ))}
        </div>
      )}

      {/* integrations */}
      <div className="mt-6 flex items-center gap-3">
        <h2 className="hud-label">External integrations</h2>
        <hr className="neon-divider flex-1" />
      </div>
      <p className="mt-1 font-mono text-[11px] text-ink-dim">
        bridge AgentOS to other agent systems — endpoints are stored locally; the redacted slot is reserved for your future integration
      </p>
      <div className="mt-2 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {integrations.map((integ) => (
          <IntegrationCard key={integ.key + String(integ.enabled)} integration={integ} onSaved={() => refresh(false)} />
        ))}
      </div>
    </div>
  )
}
