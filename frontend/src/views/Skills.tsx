import { useCallback, useEffect, useState } from 'react'
import { api, del, get, post } from '../lib/api'

interface Profile {
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
const put = (path: string, body: unknown) => api(path, { method: 'PUT', body: JSON.stringify(body) })
const patch = (path: string, body: unknown) => api(path, { method: 'PATCH', body: JSON.stringify(body) })

function ProfileCard({ profile, onChanged }: { profile: Profile; onChanged: () => void }) {
  const [p, setP] = useState({ ...profile, inject_memory: !!profile.inject_memory, is_default: !!profile.is_default })
  const [dirty, setDirty] = useState(false)
  const set = (upd: Partial<typeof p>) => { setP({ ...p, ...upd }); setDirty(true) }

  function toggleTool(list: 'allowed_tools' | 'disallowed_tools', tool: string) {
    const cur = new Set(p[list])
    cur.has(tool) ? cur.delete(tool) : cur.add(tool)
    // A tool can't be both auto-approved and blocked.
    const other: 'allowed_tools' | 'disallowed_tools' = list === 'allowed_tools' ? 'disallowed_tools' : 'allowed_tools'
    set({ [list]: [...cur], [other]: p[other].filter((t) => t !== tool) } as any)
  }

  async function save() {
    await put(`/api/profiles/${p.id}`, {
      name: p.name, description: p.description, system_prompt_append: p.system_prompt_append,
      allowed_tools: p.allowed_tools, disallowed_tools: p.disallowed_tools,
      permission_mode: p.permission_mode, model: p.model || null, max_turns: p.max_turns || null,
      inject_memory: p.inject_memory, is_default: p.is_default,
    })
    setDirty(false)
    onChanged()
  }

  return (
    <div className="rounded-lg border border-edge bg-panel p-4">
      <div className="flex items-center gap-2">
        <input
          className="rounded border border-transparent bg-transparent text-sm font-bold text-ink outline-none focus:border-edge"
          value={p.name}
          onChange={(e) => set({ name: e.target.value })}
        />
        {p.is_default ? (
          <span className="rounded bg-accent/15 px-1.5 text-[10px] font-bold uppercase text-accent">default</span>
        ) : (
          <button className="text-[10px] uppercase text-ink-dim hover:text-accent" onClick={() => set({ is_default: true })}>
            make default
          </button>
        )}
        <div className="ml-auto flex gap-2">
          {dirty && (
            <button className="rounded-md bg-accent/90 px-3 py-1 text-xs font-bold text-black hover:bg-accent" onClick={save}>
              Save
            </button>
          )}
          {!p.is_default && (
            <button
              className="text-xs text-ink-dim hover:text-err"
              onClick={async () => { await del(`/api/profiles/${p.id}`); onChanged() }}
            >
              delete
            </button>
          )}
        </div>
      </div>
      <input
        className="mt-1 w-full rounded border border-transparent bg-transparent text-xs text-ink-dim outline-none focus:border-edge"
        value={p.description ?? ''}
        placeholder="description"
        onChange={(e) => set({ description: e.target.value })}
      />

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-err">Blocked tools</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {GATEABLE_TOOLS.map((tool) => (
              <button
                key={tool}
                className={`rounded-full border px-2 py-0.5 font-mono text-[11px] ${
                  p.disallowed_tools.includes(tool)
                    ? 'border-err/60 bg-err/15 text-err'
                    : 'border-edge text-ink-dim hover:border-err/40'
                }`}
                onClick={() => toggleTool('disallowed_tools', tool)}
              >
                {tool}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-warn">
            Auto-approved tools <span title="Bypasses the approval queue entirely!">⚠</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {GATEABLE_TOOLS.map((tool) => (
              <button
                key={tool}
                className={`rounded-full border px-2 py-0.5 font-mono text-[11px] ${
                  p.allowed_tools.includes(tool)
                    ? 'border-warn/60 bg-warn/15 text-warn'
                    : 'border-edge text-ink-dim hover:border-warn/40'
                }`}
                onClick={() => toggleTool('allowed_tools', tool)}
              >
                {tool}
              </button>
            ))}
          </div>
          {p.allowed_tools.length > 0 && (
            <div className="mt-1 text-[10px] text-warn">these skip Approvals — use sparingly</div>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-xs">
        <label className="flex items-center gap-1.5 text-ink-dim">
          mode
          <select
            className="rounded border border-edge bg-bg px-1.5 py-0.5 text-xs text-ink"
            value={p.permission_mode}
            onChange={(e) => set({ permission_mode: e.target.value })}
          >
            <option value="default">default (gate everything)</option>
            <option value="acceptEdits">acceptEdits (file edits free)</option>
            <option value="plan">plan (read-only planning)</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-ink-dim">
          model
          <input
            className="w-28 rounded border border-edge bg-bg px-1.5 py-0.5 font-mono text-xs"
            placeholder="(default)"
            value={p.model ?? ''}
            onChange={(e) => set({ model: e.target.value })}
          />
        </label>
        <label className="flex items-center gap-1.5 text-ink-dim">
          max turns
          <input
            type="number"
            className="w-16 rounded border border-edge bg-bg px-1.5 py-0.5 font-mono text-xs"
            value={p.max_turns ?? ''}
            onChange={(e) => set({ max_turns: e.target.value ? Number(e.target.value) : null })}
          />
        </label>
        <label className="flex cursor-pointer items-center gap-1.5 text-ink-dim">
          <input type="checkbox" checked={p.inject_memory} onChange={(e) => set({ inject_memory: e.target.checked })} />
          inject memory
        </label>
      </div>

      <textarea
        className="mt-3 w-full rounded-md border border-edge bg-bg px-2 py-1.5 font-mono text-xs text-ink outline-none focus:border-accent"
        rows={2}
        placeholder="Extra system prompt for agents using this profile…"
        value={p.system_prompt_append ?? ''}
        onChange={(e) => set({ system_prompt_append: e.target.value })}
      />
    </div>
  )
}

export default function Skills() {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [rules, setRules] = useState<Rule[]>([])
  const [newRule, setNewRule] = useState({ tool_name: 'Bash', pattern: '', action: 'allow', match_type: 'prefix' })

  const refresh = useCallback(() => {
    get<Profile[]>('/api/profiles').then(setProfiles)
    get<Rule[]>('/api/rules').then(setRules)
  }, [])

  useEffect(refresh, [refresh])

  async function addProfile() {
    await post('/api/profiles', { name: `Profile ${profiles.length + 1}`, allowed_tools: [], disallowed_tools: [] })
    refresh()
  }

  async function addRule() {
    if (!newRule.pattern.trim()) return
    await post('/api/rules', {
      ...newRule,
      field: newRule.tool_name === 'Bash' ? 'command' : 'file_path',
      priority: newRule.action === 'deny' ? 20 : 80,
      description: 'created in Skills view',
    })
    setNewRule({ ...newRule, pattern: '' })
    refresh()
  }

  return (
    <div className="min-h-full p-4 md:p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xs font-bold uppercase tracking-[0.2em] text-ink-dim">Skills &amp; Tools</h1>
        <button className="rounded-md border border-accent/50 px-3 py-1 text-xs font-semibold text-accent hover:bg-accent/10" onClick={addProfile}>
          + New profile
        </button>
      </div>

      <div className="mt-4 grid max-w-5xl gap-4 lg:grid-cols-2">
        {profiles.map((p) => <ProfileCard key={p.id + String(p.is_default)} profile={p} onChanged={refresh} />)}
      </div>

      <h2 className="mt-8 text-xs font-bold uppercase tracking-[0.2em] text-ink-dim">Approval rules</h2>
      <p className="mt-1 text-xs text-ink-dim">First match by priority wins: <span className="text-ok">allow</span> runs silently, <span className="text-err">deny</span> blocks silently, no match asks you.</p>
      <div className="mt-3 flex max-w-4xl flex-wrap items-center gap-2">
        <select className="rounded border border-edge bg-bg px-2 py-1.5 text-xs" value={newRule.tool_name}
                onChange={(e) => setNewRule({ ...newRule, tool_name: e.target.value })}>
          {['Bash', 'Write', 'Edit', '*'].map((t) => <option key={t}>{t}</option>)}
        </select>
        <select className="rounded border border-edge bg-bg px-2 py-1.5 text-xs" value={newRule.match_type}
                onChange={(e) => setNewRule({ ...newRule, match_type: e.target.value })}>
          {['prefix', 'regex', 'glob'].map((t) => <option key={t}>{t}</option>)}
        </select>
        <input className="min-w-48 flex-1 rounded border border-edge bg-bg px-2 py-1.5 font-mono text-xs outline-none focus:border-accent"
               placeholder="pattern — e.g. git commit" value={newRule.pattern}
               onChange={(e) => setNewRule({ ...newRule, pattern: e.target.value })}
               onKeyDown={(e) => e.key === 'Enter' && addRule()} />
        <select className="rounded border border-edge bg-bg px-2 py-1.5 text-xs" value={newRule.action}
                onChange={(e) => setNewRule({ ...newRule, action: e.target.value })}>
          {['allow', 'deny', 'ask'].map((t) => <option key={t}>{t}</option>)}
        </select>
        <button className="rounded-md bg-accent/90 px-3 py-1.5 text-xs font-bold text-black hover:bg-accent" onClick={addRule}>
          Add
        </button>
      </div>

      <div className="mt-3 max-w-4xl space-y-1">
        {rules.map((r) => (
          <div key={r.id} className={`flex items-center gap-2 rounded-md border border-edge bg-panel/60 px-2 py-1.5 font-mono text-xs ${!r.enabled ? 'opacity-40' : ''}`}>
            <button
              className={`h-3.5 w-6 shrink-0 rounded-full ${r.enabled ? 'bg-ok/70' : 'bg-edge'}`}
              title={r.enabled ? 'disable' : 'enable'}
              onClick={async () => { await patch(`/api/rules/${r.id}`, { enabled: !r.enabled }); refresh() }}
            >
              <span className={`block h-2.5 w-2.5 rounded-full bg-white transition-transform ${r.enabled ? 'translate-x-3' : 'translate-x-0.5'}`} />
            </button>
            <span className={`w-12 font-bold uppercase ${r.action === 'allow' ? 'text-ok' : r.action === 'deny' ? 'text-err' : 'text-warn'}`}>{r.action}</span>
            <span className="w-14 text-accent">{r.tool_name}</span>
            <span className="w-12 text-ink-dim">{r.match_type}</span>
            <span className="flex-1 truncate text-ink" title={r.pattern}>{r.pattern}</span>
            <span className="text-ink-dim" title="priority">p{r.priority}</span>
            <span className="text-ink-dim" title="hits">{r.hit_count}×</span>
            <button className="text-ink-dim hover:text-err" onClick={async () => { await del(`/api/rules/${r.id}`); refresh() }}>✕</button>
          </div>
        ))}
      </div>
    </div>
  )
}
