import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, del, get, post } from '../lib/api'
import { useStore } from '../store'
import Ambient from '../components/Ambient'

interface Stage {
  name: string
  prompt: string
  profile_id: string | null
  model: string | null
  kind: string
}

interface Pipeline {
  id: string
  name: string
  description: string | null
  stages: Stage[]
}

interface Run {
  id: string
  pipeline_id: string
  pipeline_name?: string
  status: string
  current_stage: number
  stage_count: number
  task_ids: string[]
  error: string | null
  started_at: string
}

const put = (path: string, body: unknown) => api(path, { method: 'PUT', body: JSON.stringify(body) })
const MODELS = ['', 'opus', 'sonnet', 'haiku']

function StageCard({
  stage, index, profiles, onChange, onRemove, onDragStart, onDragOver, onDrop, dragging,
}: {
  stage: Stage
  index: number
  profiles: { id: string; name: string }[]
  onChange: (s: Stage) => void
  onRemove: () => void
  onDragStart: () => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: () => void
  dragging: boolean
}) {
  const [over, setOver] = useState(false)
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => { e.preventDefault(); setOver(true); onDragOver(e) }}
      onDragLeave={() => setOver(false)}
      onDrop={() => { setOver(false); onDrop() }}
      onDragEnd={() => setOver(false)}
      className={`glass hud-corner w-72 shrink-0 cursor-grab p-3 transition-all active:cursor-grabbing ${
        dragging ? 'dragging' : ''
      } ${over ? 'drag-over' : ''}`}
    >
      <div className="flex items-center gap-2">
        <span className="metric text-sm">{String(index + 1).padStart(2, '0')}</span>
        <input
          className="min-w-0 flex-1 rounded border border-transparent bg-transparent font-mono text-xs font-bold uppercase tracking-wider text-ink outline-none focus:border-edge"
          value={stage.name}
          onChange={(e) => onChange({ ...stage, name: e.target.value })}
        />
        <span className="cursor-grab text-ink-dimmer" title="drag to reorder">⠿</span>
        <button className="text-ink-dim hover:text-err" onClick={onRemove}>✕</button>
      </div>
      <textarea
        rows={4}
        className="mt-2 w-full resize-none rounded-md border border-edge bg-input px-2 py-1.5 font-mono text-[11px] text-ink-2 outline-none focus:border-accent/50"
        placeholder="Stage prompt — previous stage's output is appended automatically"
        value={stage.prompt}
        onChange={(e) => onChange({ ...stage, prompt: e.target.value })}
      />
      <div className="mt-2 flex gap-2">
        <select
          className="min-w-0 flex-1 rounded border border-edge bg-input px-1.5 py-1 font-mono text-[10px] text-ink-2"
          value={stage.profile_id ?? ''}
          onChange={(e) => onChange({ ...stage, profile_id: e.target.value || null })}
        >
          <option value="">profile: default</option>
          {profiles.map((p) => <option key={p.id} value={p.id}>profile: {p.name}</option>)}
        </select>
        <select
          className="w-24 rounded border border-edge bg-input px-1.5 py-1 font-mono text-[10px] text-ink-2"
          value={stage.model ?? ''}
          onChange={(e) => onChange({ ...stage, model: e.target.value || null })}
        >
          {MODELS.map((m) => <option key={m} value={m}>{m ? `model: ${m}` : 'model: default'}</option>)}
        </select>
      </div>
    </div>
  )
}

function RunRow({ run }: { run: Run }) {
  return (
    <div className="glass p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className={`font-mono text-[10px] font-bold uppercase ${
          run.status === 'done' ? 'text-ok' : run.status === 'failed' ? 'text-err'
          : run.status === 'running' ? 'text-accent' : 'text-ink-dim'
        }`}>
          {run.status === 'running' ? '● running' : run.status}
        </span>
        <span className="text-xs text-ink-2">{run.pipeline_name}</span>
        <div className="flex items-center gap-1">
          {Array.from({ length: run.stage_count }, (_, i) => {
            const state = run.status === 'done' || i < run.current_stage ? 'done'
              : i === run.current_stage && run.status === 'running' ? 'live'
              : i === run.current_stage && run.status === 'failed' ? 'fail' : 'todo'
            const dot = state === 'done' ? 'bg-ok' : state === 'live' ? 'bg-accent dot-running shadow-[0_0_10px_rgba(127,200,255,0.8)]'
              : state === 'fail' ? 'bg-err' : 'bg-ink-dimmer'
            const node = <span key={i} className={`h-2.5 w-2.5 rounded-full ${dot}`} />
            const taskId = run.task_ids[i]
            return (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <span className="h-px w-4 bg-edge" />}
                {taskId ? <Link to={`/tasks/${taskId}`}>{node}</Link> : node}
              </span>
            )
          })}
        </div>
        <span className="ml-auto font-mono text-[10px] text-ink-dimmer">
          {new Date(run.started_at.endsWith('Z') ? run.started_at : run.started_at + 'Z').toLocaleTimeString()}
        </span>
        {run.status === 'running' && (
          <button
            className="rounded border border-err/50 px-2 py-0.5 font-mono text-[10px] uppercase text-err hover:bg-err/10"
            onClick={() => post(`/api/pipelines/runs/${run.id}/cancel`).catch(() => {})}
          >
            abort
          </button>
        )}
      </div>
      {run.error && <div className="mt-1.5 font-mono text-[11px] text-err">{run.error}</div>}
    </div>
  )
}

export default function Orchestrator() {
  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [selected, setSelected] = useState<Pipeline | null>(null)
  const [profiles, setProfiles] = useState<{ id: string; name: string }[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [input, setInput] = useState('')
  const [dirty, setDirty] = useState(false)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const livePipelineRuns = useStore((s) => s.pipelineRuns)

  const refresh = useCallback(() => {
    get<Pipeline[]>('/api/pipelines').then((list) => {
      setPipelines(list)
      setSelected((cur) => (cur ? list.find((p) => p.id === cur.id) ?? list[0] ?? null : list[0] ?? null))
    })
    get<{ id: string; name: string }[]>('/api/profiles').then(setProfiles)
    get<Run[]>('/api/pipelines/runs/recent').then(setRuns)
  }, [])

  useEffect(refresh, [refresh])

  // merge live WS updates over REST snapshot
  const mergedRuns: Run[] = runs.map((r) => ({ ...r, ...(livePipelineRuns[r.id] ?? {}) }))
  for (const live of Object.values(livePipelineRuns) as Run[]) {
    if (!mergedRuns.some((r) => r.id === live.id)) {
      mergedRuns.unshift({ ...live, pipeline_name: pipelines.find((p) => p.id === live.pipeline_id)?.name })
    }
  }
  mergedRuns.sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''))

  function mutate(updater: (p: Pipeline) => Pipeline) {
    if (!selected) return
    setSelected(updater(selected))
    setDirty(true)
  }

  function reorder(from: number, to: number) {
    mutate((p) => {
      const stages = [...p.stages]
      const [moved] = stages.splice(from, 1)
      stages.splice(to, 0, moved)
      return { ...p, stages }
    })
  }

  async function save() {
    if (!selected) return
    await put(`/api/pipelines/${selected.id}`, {
      name: selected.name, description: selected.description, stages: selected.stages,
    })
    setDirty(false)
    refresh()
  }

  async function addPipeline() {
    const p = await post<Pipeline>('/api/pipelines', {
      name: `Pipeline ${pipelines.length + 1}`,
      stages: [
        { name: 'Research', prompt: 'Research the topic thoroughly. Produce structured findings.', profile_id: null, model: null, kind: 'general' },
        { name: 'Execute', prompt: 'Act on the findings from the previous stage.', profile_id: null, model: null, kind: 'general' },
      ],
    })
    refresh()
    setSelected(p)
  }

  async function run() {
    if (!selected) return
    if (dirty) await save()
    await post(`/api/pipelines/${selected.id}/run`, { input })
    get<Run[]>('/api/pipelines/runs/recent').then(setRuns)
  }

  return (
    <div className="relative min-h-full p-4 md:p-6">
      <Ambient color="#f472b6" />
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="hud-label !text-xs" style={{ color: '#f472b6' }}>Orchestration Pipelines</h1>
          <div className="mt-0.5 font-mono text-[10px] text-ink-dimmer">
            chain agents · each stage hands its output to the next · drag to reorder
          </div>
        </div>
        <div className="ml-auto flex gap-2">
          <button
            className="hud-corner glass-bright px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-widest text-accent hover:shadow-[0_0_20px_rgba(127,200,255,0.25)]"
            onClick={addPipeline}
          >
            + new pipeline
          </button>
        </div>
      </div>

      {/* pipeline tabs */}
      <div className="mt-4 flex flex-wrap gap-2">
        {pipelines.map((p) => (
          <button
            key={p.id}
            className={`rounded-md border px-3 py-1.5 font-mono text-xs transition-colors ${
              selected?.id === p.id
                ? 'border-accent/50 bg-accent/10 text-accent'
                : 'border-edge text-ink-dim hover:text-ink'
            }`}
            onClick={() => { setSelected(p); setDirty(false) }}
          >
            ⧉ {p.name}
          </button>
        ))}
      </div>

      {selected && (
        <div className="glass mt-4 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <input
              className="rounded border border-transparent bg-transparent font-mono text-sm font-bold text-ink outline-none focus:border-edge"
              value={selected.name}
              onChange={(e) => mutate((p) => ({ ...p, name: e.target.value }))}
            />
            <div className="ml-auto flex gap-2">
              {dirty && (
                <button className="rounded-md bg-accent/90 px-4 py-1.5 font-mono text-xs font-bold uppercase text-bg hover:bg-accent" onClick={save}>
                  save
                </button>
              )}
              <button
                className="rounded-md border border-err/40 px-3 py-1.5 font-mono text-[11px] uppercase text-err hover:bg-err/10"
                onClick={async () => {
                  if (window.confirm(`Delete pipeline "${selected.name}"?`)) {
                    await del(`/api/pipelines/${selected.id}`)
                    setSelected(null)
                    refresh()
                  }
                }}
              >
                delete
              </button>
            </div>
          </div>

          {/* stage flow */}
          <div className="mt-4 flex items-stretch gap-0 overflow-x-auto pb-2">
            {selected.stages.map((stage, i) => (
              <div key={i} className="flex items-center">
                {i > 0 && (
                  <div className="flex w-8 shrink-0 items-center justify-center">
                    <span className="font-mono" style={{ color: '#f472b6', textShadow: '0 0 12px rgba(244,114,182,0.7)' }}>→</span>
                  </div>
                )}
                <StageCard
                  stage={stage}
                  index={i}
                  profiles={profiles}
                  dragging={dragIndex === i}
                  onChange={(s) => mutate((p) => ({ ...p, stages: p.stages.map((x, j) => (j === i ? s : x)) }))}
                  onRemove={() => mutate((p) => ({ ...p, stages: p.stages.filter((_, j) => j !== i) }))}
                  onDragStart={() => setDragIndex(i)}
                  onDragOver={() => {}}
                  onDrop={() => {
                    if (dragIndex !== null && dragIndex !== i) reorder(dragIndex, i)
                    setDragIndex(null)
                  }}
                />
              </div>
            ))}
            <div className="ml-3 flex items-center">
              <button
                className="glass h-24 w-24 shrink-0 rounded-xl font-mono text-2xl text-ink-dim transition-all hover:text-accent hover:shadow-[0_0_20px_rgba(127,200,255,0.2)]"
                onClick={() => mutate((p) => ({
                  ...p,
                  stages: [...p.stages, { name: `Stage ${p.stages.length + 1}`, prompt: '', profile_id: null, model: null, kind: 'general' }],
                }))}
              >
                +
              </button>
            </div>
          </div>

          {/* launch */}
          <hr className="neon-divider my-4" />
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-64 flex-1">
              <div className="hud-label mb-1">mission input (handed to stage 01)</div>
              <textarea
                rows={2}
                className="w-full resize-none rounded-md border border-edge bg-input px-3 py-2 font-mono text-xs text-ink outline-none focus:border-accent/50"
                placeholder="e.g. 'Evaluate whether AgentOS should add voice control'"
                value={input}
                onChange={(e) => setInput(e.target.value)}
              />
            </div>
            <button
              className="rounded-md px-6 py-2.5 font-mono text-sm font-bold uppercase tracking-[0.15em] text-bg transition-all hover:shadow-[0_0_28px_rgba(244,114,182,0.45)] disabled:opacity-40"
              style={{ background: '#f472b6' }}
              disabled={selected.stages.length === 0}
              onClick={run}
            >
              ▶ launch
            </button>
          </div>
        </div>
      )}

      {pipelines.length === 0 && (
        <div className="glass mt-4 border-dashed p-10 text-center text-sm text-ink-dim">
          No pipelines yet. Create one and chain Research → Draft → Review agents.
        </div>
      )}

      <div className="mt-6 flex items-center gap-3">
        <h2 className="hud-label">Run history</h2>
        <hr className="neon-divider flex-1" />
      </div>
      <div className="mt-2 space-y-2">
        {mergedRuns.slice(0, 15).map((r) => <RunRow key={r.id} run={r} />)}
        {mergedRuns.length === 0 && <div className="text-sm text-ink-dim">No runs yet.</div>}
      </div>
    </div>
  )
}
