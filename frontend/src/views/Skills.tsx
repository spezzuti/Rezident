import { useCallback, useEffect, useState } from 'react'
import { api, del, get, post } from '../lib/api'
import Ambient from '../components/Ambient'

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

const GATEABLE_TOOLS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch']
const ICONS = ['◆', '◉', '◈', '☿', '⚚', '⚒', 'Ω', 'Δ', 'Ψ', '☾', '✦', '⟁']
// wasteland swatches: amber, pip green, dusty teal, nuka red, vault gold, chem purple, quantum blue, olive
const COLORS = ['#e5a747', '#8fbf4d', '#5fa8a0', '#d8564a', '#f0c14b', '#b08fd0', '#46c0e0', '#a3a55b']
const MODEL_TIER: Record<string, { label: string; cls: string }> = {
  haiku: { label: 'HAIKU · cheap & fast', cls: 'text-ok border-ok/40' },
  sonnet: { label: 'SONNET · balanced', cls: 'text-accent border-accent/40' },
  opus: { label: 'OPUS · premium', cls: 'text-err border-err/40' },
  '': { label: 'DEFAULT MODEL', cls: 'text-ink-dim border-edge' },
}

const put = (path: string, body: unknown) => api(path, { method: 'PUT', body: JSON.stringify(body) })
const patch = (path: string, body: unknown) => api(path, { method: 'PATCH', body: JSON.stringify(body) })

function AgentCard({ profile, onChanged }: { profile: AgentProfile; onChanged: () => void }) {
  const [p, setP] = useState({ ...profile, inject_memory: !!profile.inject_memory, is_default: !!profile.is_default })
  const [open, setOpen] = useState(false)
  const [dirty, setDirty] = useState(false)
  const set = (upd: Partial<typeof p>) => { setP({ ...p, ...upd }); setDirty(true) }
  const tier = MODEL_TIER[p.model ?? ''] ?? MODEL_TIER['']

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

  return (
    <div
      className="glass hud-corner relative p-4 transition-all hover:-translate-y-0.5"
      style={{ boxShadow: p.is_default ? `0 0 24px ${p.color}33, inset 0 1px 0 rgba(226,232,240,0.04)` : undefined }}
    >
      <div className="flex items-start gap-3">
        <div
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border text-2xl"
          style={{ color: p.color, borderColor: `${p.color}55`, background: `${p.color}11`, textShadow: `0 0 18px ${p.color}` }}
        >
          {p.icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <input
              className="min-w-0 rounded border border-transparent bg-transparent font-mono text-base font-bold tracking-wide outline-none focus:border-edge"
              style={{ color: p.color }}
              value={p.name}
              onChange={(e) => set({ name: e.target.value })}
            />
            {p.is_default ? (
              <span className="rounded border border-accent/40 bg-accent/10 px-1.5 font-mono text-[9px] font-bold uppercase tracking-widest text-accent">
                active default
              </span>
            ) : (
              <button
                className="rounded border border-edge px-1.5 font-mono text-[9px] uppercase tracking-widest text-ink-dim hover:border-accent/40 hover:text-accent"
                onClick={() => set({ is_default: true })}
              >
                make default
              </button>
            )}
          </div>
          <input
            className="mt-0.5 w-full rounded border border-transparent bg-transparent font-mono text-[11px] text-ink-dim outline-none focus:border-edge"
            value={p.role}
            placeholder="role — e.g. Deep research · read-only"
            onChange={(e) => set({ role: e.target.value })}
          />
          <span className={`mt-1.5 inline-block rounded border px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-widest ${tier.cls}`}>
            {tier.label}
          </span>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          {dirty && (
            <button className="rounded-md bg-accent/90 px-3 py-1 font-mono text-[10px] font-bold uppercase text-bg hover:bg-accent" onClick={save}>
              save
            </button>
          )}
          <button className="font-mono text-[10px] uppercase tracking-widest text-ink-dim hover:text-ink" onClick={() => setOpen(!open)}>
            {open ? '▴ close' : '▾ configure'}
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-4 space-y-3 border-t border-edge pt-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex gap-1">
              {ICONS.map((icon) => (
                <button key={icon}
                        className={`h-7 w-7 rounded border text-sm ${p.icon === icon ? 'border-accent/60 bg-accent/10' : 'border-edge text-ink-dim hover:text-ink'}`}
                        style={p.icon === icon ? { color: p.color } : undefined}
                        onClick={() => set({ icon })}>
                  {icon}
                </button>
              ))}
            </div>
            <div className="flex gap-1">
              {COLORS.map((c) => (
                <button key={c}
                        className={`h-5 w-5 rounded-full border-2 ${p.color === c ? 'border-ink' : 'border-transparent'}`}
                        style={{ background: c, boxShadow: p.color === c ? `0 0 12px ${c}` : undefined }}
                        onClick={() => set({ color: c })} />
              ))}
            </div>
          </div>

          <textarea
            className="w-full rounded-md border border-edge bg-input px-2 py-1.5 font-mono text-[11px] text-ink-2 outline-none focus:border-accent/50"
            rows={3}
            placeholder="Persona — who is this agent? Injected into its system prompt."
            value={p.system_prompt_append ?? ''}
            onChange={(e) => set({ system_prompt_append: e.target.value })}
          />

          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <div className="hud-label !text-[9px] !text-err">Blocked tools</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {GATEABLE_TOOLS.map((tool) => (
                  <button key={tool}
                          className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${
                            p.disallowed_tools.includes(tool) ? 'border-err/60 bg-err/15 text-err' : 'border-edge text-ink-dim hover:border-err/40'
                          }`}
                          onClick={() => toggleTool('disallowed_tools', tool)}>
                    {tool}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="hud-label !text-[9px] !text-warn">Auto-approved ⚠ skips Approvals</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {GATEABLE_TOOLS.map((tool) => (
                  <button key={tool}
                          className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${
                            p.allowed_tools.includes(tool) ? 'border-warn/60 bg-warn/15 text-warn' : 'border-edge text-ink-dim hover:border-warn/40'
                          }`}
                          onClick={() => toggleTool('allowed_tools', tool)}>
                    {tool}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4 font-mono text-[11px] text-ink-dim">
            <label className="flex items-center gap-1.5">
              model
              <select className="rounded border border-edge bg-input px-1.5 py-0.5 text-[11px] text-ink"
                      value={p.model ?? ''} onChange={(e) => set({ model: e.target.value || null })}>
                <option value="">default</option>
                <option value="haiku">haiku — cheap</option>
                <option value="sonnet">sonnet — balanced</option>
                <option value="opus">opus — premium</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              mode
              <select className="rounded border border-edge bg-input px-1.5 py-0.5 text-[11px] text-ink"
                      value={p.permission_mode} onChange={(e) => set({ permission_mode: e.target.value })}>
                <option value="default">gate everything</option>
                <option value="acceptEdits">file edits free</option>
                <option value="plan">plan only</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              max turns
              <input type="number" className="w-14 rounded border border-edge bg-input px-1.5 py-0.5 text-[11px]"
                     value={p.max_turns ?? ''} onChange={(e) => set({ max_turns: e.target.value ? Number(e.target.value) : null })} />
            </label>
            <label className="flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={p.inject_memory} onChange={(e) => set({ inject_memory: e.target.checked })} />
              memory core
            </label>
            {!p.is_default && (
              <button className="ml-auto text-err/80 hover:text-err"
                      onClick={async () => { if (window.confirm(`Retire ${p.name}?`)) { await del(`/api/profiles/${p.id}`); onChanged() } }}>
                retire agent
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default function Skills() {
  const [profiles, setProfiles] = useState<AgentProfile[]>([])
  const [rules, setRules] = useState<Rule[]>([])
  const [newRule, setNewRule] = useState({ tool_name: 'Bash', pattern: '', action: 'allow', match_type: 'prefix' })

  const refresh = useCallback(() => {
    get<AgentProfile[]>('/api/profiles').then(setProfiles)
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

  return (
    <div className="relative min-h-full p-4 md:p-6">
      <Ambient color="var(--sec-companions)" />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="hud-label !text-xs" style={{ color: 'var(--sec-companions)' }}>Companions</h1>
          <div className="mt-0.5 font-mono text-[10px] text-ink-dimmer">
            named specialists · right model for the right job · don't send Opus to mop the vault floors
          </div>
        </div>
        <button
          className="hud-corner glass-bright btn-glow px-4 py-2 font-mono text-xs font-bold uppercase tracking-widest"
          style={{ color: 'var(--sec-companions)', ['--glow-c' as any]: 'var(--sec-companions)' }}
          onClick={summon}
        >
          + Recruit Companion
        </button>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {profiles.map((p) => (
          <AgentCard key={p.id + String(p.is_default) + p.icon + p.color} profile={p} onChanged={refresh} />
        ))}
      </div>

      <div className="mt-8 flex items-center gap-3">
        <h2 className="hud-label">Tool firewall rules</h2>
        <hr className="neon-divider flex-1" />
      </div>
      <p className="mt-1 font-mono text-[11px] text-ink-dim">
        first match by priority wins — <span className="text-ok">allow</span> runs silently ·{' '}
        <span className="text-err">deny</span> blocks silently · no match asks you
      </p>
      <div className="mt-3 flex max-w-4xl flex-wrap items-center gap-2">
        <select className="rounded border border-edge bg-input px-2 py-1.5 font-mono text-xs" value={newRule.tool_name}
                onChange={(e) => setNewRule({ ...newRule, tool_name: e.target.value })}>
          {['Bash', 'Write', 'Edit', '*'].map((t) => <option key={t}>{t}</option>)}
        </select>
        <select className="rounded border border-edge bg-input px-2 py-1.5 font-mono text-xs" value={newRule.match_type}
                onChange={(e) => setNewRule({ ...newRule, match_type: e.target.value })}>
          {['prefix', 'regex', 'glob'].map((t) => <option key={t}>{t}</option>)}
        </select>
        <input className="min-w-48 flex-1 rounded border border-edge bg-input px-2 py-1.5 font-mono text-xs outline-none focus:border-accent/50"
               placeholder="pattern — e.g. git commit" value={newRule.pattern}
               onChange={(e) => setNewRule({ ...newRule, pattern: e.target.value })}
               onKeyDown={(e) => e.key === 'Enter' && addRule()} />
        <select className="rounded border border-edge bg-input px-2 py-1.5 font-mono text-xs" value={newRule.action}
                onChange={(e) => setNewRule({ ...newRule, action: e.target.value })}>
          {['allow', 'deny', 'ask'].map((t) => <option key={t}>{t}</option>)}
        </select>
        <button className="rounded-md bg-accent/90 px-3 py-1.5 font-mono text-xs font-bold uppercase text-bg hover:bg-accent" onClick={addRule}>
          add
        </button>
      </div>

      <div className="mt-3 max-w-4xl space-y-1">
        {rules.map((r) => (
          <div key={r.id} className={`flex items-center gap-2 rounded-md border border-edge bg-panel/60 px-2 py-1.5 font-mono text-xs ${!r.enabled ? 'opacity-40' : ''}`}>
            <button
              className={`h-3.5 w-6 shrink-0 rounded-full ${r.enabled ? 'bg-ok/70' : 'bg-panel-2'}`}
              title={r.enabled ? 'disable' : 'enable'}
              onClick={async () => { await patch(`/api/rules/${r.id}`, { enabled: !r.enabled }); refresh() }}
            >
              <span className={`block h-2.5 w-2.5 rounded-full bg-white transition-transform ${r.enabled ? 'translate-x-3' : 'translate-x-0.5'}`} />
            </button>
            <span className={`w-12 font-bold uppercase ${r.action === 'allow' ? 'text-ok' : r.action === 'deny' ? 'text-err' : 'text-warn'}`}>{r.action}</span>
            <span className="w-14 text-accent">{r.tool_name}</span>
            <span className="w-12 text-ink-dim">{r.match_type}</span>
            <span className="flex-1 truncate text-ink-2" title={r.pattern}>{r.pattern}</span>
            <span className="text-ink-dim" title="priority">p{r.priority}</span>
            <span className="text-ink-dim" title="hits">{r.hit_count}×</span>
            <button className="text-ink-dim hover:text-err" onClick={async () => { await del(`/api/rules/${r.id}`); refresh() }}>✕</button>
          </div>
        ))}
      </div>
    </div>
  )
}
