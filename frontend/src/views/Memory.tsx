import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { del, get, post, api } from '../lib/api'
import MemoryGraph from '../components/MemoryGraph'

interface Fact {
  id: string
  content: string
  tags: string
  source: string
  enabled: number
  updated_at: string
}

interface Episode {
  id: string
  task_id: string
  title: string
  summary: string | null
  outcome: string
  cost_usd: number
  created_at: string
}

const patch = (path: string, body: unknown) =>
  api(path, { method: 'PATCH', body: JSON.stringify(body) })

function FactRow({ fact, onChanged }: { fact: Fact; onChanged: () => void }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(fact.content)

  async function save() {
    if (text.trim() && text !== fact.content) {
      await patch(`/api/memory/facts/${fact.id}`, { content: text.trim() })
    }
    setEditing(false)
    onChanged()
  }

  return (
    <div className={`event-in flex items-start gap-3 rounded-lg border border-edge bg-panel px-3 py-2 ${!fact.enabled ? 'opacity-50' : ''}`}>
      <button
        title={fact.enabled ? 'disable (stops injecting into agents)' : 'enable'}
        className={`mt-0.5 h-4 w-7 shrink-0 rounded-full transition-colors ${fact.enabled ? 'bg-ok/70' : 'bg-edge'}`}
        onClick={async () => {
          await patch(`/api/memory/facts/${fact.id}`, { enabled: !fact.enabled })
          onChanged()
        }}
      >
        <span className={`block h-3 w-3 rounded-full bg-white transition-transform ${fact.enabled ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
      </button>
      {editing ? (
        <textarea
          autoFocus
          className="flex-1 rounded-md border border-accent bg-bg px-2 py-1 text-sm outline-none"
          value={text}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && save()}
        />
      ) : (
        <div className="flex-1 cursor-text text-sm text-ink" onClick={() => setEditing(true)}>
          {fact.content}
          {fact.tags && <span className="ml-2 font-mono text-[10px] text-accent">{fact.tags}</span>}
        </div>
      )}
      <button
        className="text-xs text-ink-dim hover:text-err"
        title="delete"
        onClick={async () => {
          await del(`/api/memory/facts/${fact.id}`)
          onChanged()
        }}
      >
        ✕
      </button>
    </div>
  )
}

export default function Memory() {
  const [facts, setFacts] = useState<Fact[]>([])
  const [episodes, setEpisodes] = useState<Episode[]>([])
  const [q, setQ] = useState('')
  const [newFact, setNewFact] = useState('')
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const factRefs = useRef<Record<string, HTMLDivElement | null>>({})

  const selectFromGraph = useCallback((id: string) => {
    setHighlightId(id)
    factRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setTimeout(() => setHighlightId(null), 2500)
  }, [])

  const refresh = useCallback(() => {
    const suffix = q ? `?q=${encodeURIComponent(q)}` : ''
    get<Fact[]>(`/api/memory/facts${suffix}`).then(setFacts)
    get<Episode[]>(`/api/memory/episodes${suffix}`).then(setEpisodes)
  }, [q])

  useEffect(() => {
    const t = setTimeout(refresh, 200)
    return () => clearTimeout(t)
  }, [refresh])

  async function addFact() {
    if (!newFact.trim()) return
    await post('/api/memory/facts', { content: newFact.trim() })
    setNewFact('')
    refresh()
  }

  return (
    <div className="min-h-full p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-4">
        <div>
          <h1 className="hud-label !text-xs">Memory Core</h1>
          <div className="mt-0.5 font-mono text-[10px] text-ink-dimmer">
            {facts.filter((f) => f.enabled).length} facts live · {episodes.length} episodes logged
          </div>
        </div>
        <input
          className="ml-auto w-full max-w-md rounded-md border border-edge bg-input px-3 py-2 text-sm outline-none focus:border-accent/50 focus:shadow-[0_0_20px_rgba(127,200,255,0.12)]"
          placeholder="⌕ search the core…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div className="mt-4">
        <MemoryGraph
          facts={facts}
          episodes={episodes}
          onSelectFact={selectFromGraph}
        />
      </div>

      <h2 className="hud-label mt-6">
        Facts <span className="font-normal normal-case !tracking-normal text-ink-dimmer">— injected into every agent's system prompt</span>
      </h2>
      <div className="mt-2 flex max-w-3xl gap-2">
        <input
          className="flex-1 rounded-md border border-edge bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
          placeholder="Add a durable fact — e.g. 'My repos live in C:\Users\sleve\src'"
          value={newFact}
          onChange={(e) => setNewFact(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addFact()}
        />
        <button
          className="rounded-md bg-accent/90 px-4 text-sm font-semibold text-black hover:bg-accent disabled:opacity-50"
          disabled={!newFact.trim()}
          onClick={addFact}
        >
          Save
        </button>
      </div>
      <div className="mt-3 max-w-3xl space-y-2">
        {facts.map((f) => (
          <div
            key={f.id}
            ref={(el) => { factRefs.current[f.id] = el }}
            className={highlightId === f.id ? 'rounded-lg ring-2 ring-accent shadow-[0_0_24px_rgba(127,200,255,0.35)]' : ''}
          >
            <FactRow fact={f} onChanged={refresh} />
          </div>
        ))}
        {facts.length === 0 && (
          <div className="rounded-lg border border-dashed border-edge p-6 text-center text-sm text-ink-dim">
            No facts saved{q ? ' matching your search' : ' yet'}.
          </div>
        )}
      </div>

      <h2 className="mt-8 text-xs font-bold uppercase tracking-[0.2em] text-ink-dim">Episode history</h2>
      <div className="mt-2 max-w-3xl space-y-1.5">
        {episodes.map((e) => (
          <Link
            key={e.id}
            to={`/tasks/${e.task_id}`}
            className="flex items-baseline gap-3 rounded-md border border-edge bg-panel/60 px-3 py-1.5 text-sm hover:bg-panel-2"
          >
            <span className={`font-mono text-[10px] font-bold uppercase ${
              e.outcome === 'done' ? 'text-ok' : e.outcome === 'failed' ? 'text-err' : 'text-ink-dim'
            }`}>
              {e.outcome}
            </span>
            <span className="truncate text-ink">{e.title}</span>
            <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-dim">
              ~${e.cost_usd.toFixed(3)} · {new Date(e.created_at).toLocaleDateString()}
            </span>
          </Link>
        ))}
        {episodes.length === 0 && <div className="text-sm text-ink-dim">No episodes yet.</div>}
      </div>
    </div>
  )
}
