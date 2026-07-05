import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, del, get, post } from '../lib/api'
import { useStore } from '../store'

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

type Profile = { id: string; name: string }

const put = (path: string, body: unknown) => api(path, { method: 'PUT', body: JSON.stringify(body) })
const MODELS = ['', 'opus', 'sonnet', 'haiku']

const badgeMod = (status: string) =>
  ['done', 'running', 'failed', 'cancelled'].includes(status) ? status : 'queued'

/* ---- shared skeuomorphic bits ---- */
const NODE_BASE: React.CSSProperties = {
  width: 34, height: 34, borderRadius: '50%', border: '2px solid #10151a',
  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13,
  fontFamily: 'var(--wl-font-mono)', fontWeight: 600,
}
const NODE_STATES: Record<'running' | 'done' | 'pending', React.CSSProperties> = {
  running: {
    background: 'radial-gradient(circle at 35% 30%, #74dd8f, #1e4a2c)', color: '#0d1a10',
    boxShadow: '0 0 14px rgba(125,232,154,.55), 0 2px 4px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.2)',
  },
  done: {
    background: 'radial-gradient(circle at 35% 30%, #9cc97e, #5d8a42)', color: '#1e2618',
    boxShadow: '0 2px 4px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.2)',
  },
  pending: {
    background: 'radial-gradient(circle at 35% 30%, #586a7a, #2b3742)', color: '#aebccb',
    boxShadow: '0 2px 4px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.2)',
  },
}
const PIPE_STYLE: React.CSSProperties = {
  flex: 1, height: 8, margin: '0 2px 30px', borderRadius: 4,
  background: 'linear-gradient(180deg,#485866,#28323d)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,.15), inset 0 -1px 2px rgba(0,0,0,.5)',
  position: 'relative',
}
const CLAMP_STYLE: React.CSSProperties = {
  position: 'absolute', left: '50%', top: -3, width: 8, height: 14,
  background: 'linear-gradient(180deg,#4a4030,#2c241a)', border: '1px solid #10151a',
  borderRadius: 2, transform: 'translateX(-50%)',
}
const SELECT_STYLE: React.CSSProperties = {
  background: '#0a0f14', border: '1px solid var(--wl-border)', borderRadius: 3,
  color: '#aebccb', fontFamily: 'var(--wl-font-mono)', fontSize: 10, padding: '5px 8px',
}

function PipelinePanel({
  pipeline, profiles, lastRun, rusty, refresh, refreshRuns,
}: {
  pipeline: Pipeline
  profiles: Profile[]
  lastRun: Run | undefined
  rusty: boolean
  refresh: () => void
  refreshRuns: () => void
}) {
  const [p, setP] = useState(pipeline)
  const [dirty, setDirty] = useState(false)
  const [input, setInput] = useState('')
  const [editing, setEditing] = useState<number | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)

  function mutate(updater: (cur: Pipeline) => Pipeline) {
    setP((cur) => updater(cur))
    setDirty(true)
  }

  function reorder(from: number, to: number) {
    mutate((cur) => {
      const stages = [...cur.stages]
      const [moved] = stages.splice(from, 1)
      stages.splice(to, 0, moved)
      return { ...cur, stages }
    })
    setEditing(null)
  }

  async function save() {
    await put(`/api/pipelines/${p.id}`, { name: p.name, description: p.description, stages: p.stages })
    setDirty(false)
    refresh()
  }

  async function run() {
    if (dirty) await save()
    await post(`/api/pipelines/${p.id}/run`, { input })
    refreshRuns()
  }

  function stageState(i: number): 'running' | 'done' | 'pending' {
    if (!lastRun) return 'pending'
    if (lastRun.status === 'done' || i < lastRun.current_stage) return 'done'
    if (i === lastRun.current_stage && lastRun.status === 'running') return 'running'
    return 'pending'
  }

  const editingStage = editing !== null ? p.stages[editing] : undefined

  return (
    <div className="wl-equip" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <span className="wl-screw wl-screw--tl" />
      <span className={`wl-screw ${rusty ? 'wl-screw--rusty ' : ''}wl-screw--tr`} />

      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <input
          value={p.name}
          onChange={(e) => mutate((cur) => ({ ...cur, name: e.target.value }))}
          style={{
            fontFamily: 'var(--wl-font-display)', fontSize: 13, fontWeight: 700, letterSpacing: 1.5,
            color: '#dfd8c6', background: 'transparent', border: '1px solid transparent', borderRadius: 3,
            padding: '2px 4px', outline: 'none', minWidth: 0, width: 230,
          }}
        />
        {lastRun && <span className={`wl-badge wl-badge--${badgeMod(lastRun.status)}`}>{lastRun.status.toUpperCase()}</span>}
        <span className="wl-mono" style={{ marginLeft: 'auto', fontSize: 10, color: '#8fa0b0' }}>
          {p.stages.length} STAGES{dirty ? ' · UNSAVED' : ''}
        </span>
        {dirty && (
          <div className="wl-btn-housing" style={{ padding: 3 }}>
            <button className="wl-btn wl-btn--steel" style={{ fontSize: 10, padding: '5px 12px' }} onClick={save}>
              SAVE
            </button>
          </div>
        )}
        <button
          title="scrap pipeline"
          className="wl-mono"
          style={{ background: 'none', border: '1px solid rgba(178,86,68,.6)', borderRadius: 2, color: '#dd8471', fontSize: 9, letterSpacing: 1, padding: '2px 7px', cursor: 'pointer' }}
          onClick={async () => {
            if (window.confirm(`Delete pipeline "${p.name}"?`)) {
              await del(`/api/pipelines/${p.id}`)
              refresh()
            }
          }}
        >
          ✕ SCRAP
        </button>
      </div>

      {/* stage flow — nodes joined by pipes */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 0, padding: '0 4px', overflowX: 'auto' }}>
        {p.stages.map((stage, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, minWidth: 86 }}>
              <div
                draggable
                onDragStart={() => setDragIndex(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragIndex !== null && dragIndex !== i) reorder(dragIndex, i)
                  setDragIndex(null)
                }}
                onDragEnd={() => setDragIndex(null)}
                onClick={() => setEditing(editing === i ? null : i)}
                title="click to edit · drag to reorder"
                style={{
                  ...NODE_BASE,
                  ...NODE_STATES[stageState(i)],
                  cursor: 'grab',
                  opacity: dragIndex === i ? 0.45 : 1,
                  outline: editing === i ? '2px solid var(--wl-yellow)' : 'none',
                  outlineOffset: 2,
                }}
              >
                {String(i + 1).padStart(2, '0')}
              </div>
              <span
                className="wl-mono"
                style={{ fontSize: 9.5, color: editing === i ? 'var(--wl-yellow)' : '#aebccb', maxWidth: 120, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
              >
                {stage.name || `STAGE ${i + 1}`}
              </span>
              <span className="wl-mono" style={{ fontSize: 8.5, color: '#5d6e7e' }}>
                {profiles.find((pr) => pr.id === stage.profile_id)?.name ?? 'default'} · {stage.model || 'default'}
              </span>
            </div>
            <div style={PIPE_STYLE}><span style={CLAMP_STYLE} /></div>
          </div>
        ))}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, minWidth: 86 }}>
          <button
            title="add stage"
            onClick={() => {
              mutate((cur) => ({
                ...cur,
                stages: [...cur.stages, { name: `Stage ${cur.stages.length + 1}`, prompt: '', profile_id: null, model: null, kind: 'general' }],
              }))
              setEditing(p.stages.length)
            }}
            style={{
              ...NODE_BASE, background: 'transparent', border: '2px dashed #485866',
              color: '#8fa0b0', fontSize: 16, cursor: 'pointer',
            }}
          >
            +
          </button>
          <span className="wl-mono" style={{ fontSize: 9.5, color: '#5d6e7e' }}>ADD STAGE</span>
          <span className="wl-mono" style={{ fontSize: 8.5, color: 'transparent' }}>·</span>
        </div>
      </div>

      {/* stage editor — open the node's service hatch */}
      {editing !== null && editingStage && (
        <div className="wl-tile" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="wl-mono" style={{ fontSize: 9, letterSpacing: 2, color: '#d9ad2e' }}>
              STAGE {String(editing + 1).padStart(2, '0')}
            </span>
            <input
              className="wl-input"
              style={{ flex: 1, minWidth: 0, padding: '5px 8px', fontSize: 11 }}
              value={editingStage.name}
              onChange={(e) => mutate((cur) => ({ ...cur, stages: cur.stages.map((s, j) => (j === editing ? { ...s, name: e.target.value } : s)) }))}
            />
            <button
              className="wl-mono"
              style={{ background: 'none', border: '1px solid rgba(178,86,68,.6)', borderRadius: 2, color: '#dd8471', fontSize: 9, letterSpacing: 1, padding: '2px 7px', cursor: 'pointer' }}
              onClick={() => {
                mutate((cur) => ({ ...cur, stages: cur.stages.filter((_, j) => j !== editing) }))
                setEditing(null)
              }}
            >
              ✕ REMOVE
            </button>
          </div>
          <textarea
            rows={4}
            className="wl-input"
            style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', display: 'block' }}
            placeholder="Stage prompt — previous stage's output is appended automatically"
            value={editingStage.prompt}
            onChange={(e) => mutate((cur) => ({ ...cur, stages: cur.stages.map((s, j) => (j === editing ? { ...s, prompt: e.target.value } : s)) }))}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <select
              style={{ ...SELECT_STYLE, flex: 1, minWidth: 0 }}
              value={editingStage.profile_id ?? ''}
              onChange={(e) => mutate((cur) => ({ ...cur, stages: cur.stages.map((s, j) => (j === editing ? { ...s, profile_id: e.target.value || null } : s)) }))}
            >
              <option value="">profile: default</option>
              {profiles.map((pr) => <option key={pr.id} value={pr.id}>profile: {pr.name}</option>)}
            </select>
            <select
              style={{ ...SELECT_STYLE, width: 130 }}
              value={editingStage.model ?? ''}
              onChange={(e) => mutate((cur) => ({ ...cur, stages: cur.stages.map((s, j) => (j === editing ? { ...s, model: e.target.value || null } : s)) }))}
            >
              {MODELS.map((m) => <option key={m} value={m}>{m ? `model: ${m}` : 'model: default'}</option>)}
            </select>
          </div>
        </div>
      )}

      {/* launch console */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="wl-microlabel" style={{ marginBottom: 4 }}>MISSION INPUT — HANDED TO STAGE 01</div>
          <textarea
            rows={2}
            className="wl-input"
            style={{ width: '100%', boxSizing: 'border-box', resize: 'none', display: 'block' }}
            placeholder="e.g. 'Evaluate whether AgentOS should add voice control'"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </div>
        <div className="wl-btn-housing">
          <button
            className="wl-btn"
            disabled={p.stages.length === 0}
            style={p.stages.length === 0 ? { opacity: 0.5, cursor: 'default' } : undefined}
            onClick={run}
          >
            ▶ LAUNCH
          </button>
        </div>
      </div>
    </div>
  )
}

function RunRow({ run }: { run: Run }) {
  return (
    <div className="wl-tile" style={{ padding: '9px 12px' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
        <span className={`wl-badge wl-badge--${badgeMod(run.status)}`}>{run.status.toUpperCase()}</span>
        <span className="wl-mono" style={{ fontSize: 11, color: '#aebccb' }}>{run.pipeline_name}</span>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {Array.from({ length: run.stage_count }, (_, i) => {
            const state = run.status === 'done' || i < run.current_stage ? 'done'
              : i === run.current_stage && run.status === 'running' ? 'live'
              : i === run.current_stage && run.status === 'failed' ? 'fail' : 'todo'
            const dotStyle: React.CSSProperties = state === 'done'
              ? { background: 'var(--wl-green)' }
              : state === 'live'
                ? { background: 'var(--wl-phos-g)', boxShadow: '0 0 8px rgba(125,232,154,.7)', animation: 'wl-blink 2.4s infinite' }
                : state === 'fail'
                  ? { background: '#dd8471', boxShadow: '0 0 6px rgba(178,86,68,.6)' }
                  : { background: '#32281f', boxShadow: 'inset 0 1px 1px rgba(0,0,0,.6)' }
            const node = <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', ...dotStyle }} />
            const taskId = run.task_ids[i]
            return (
              <span key={i} style={{ display: 'flex', alignItems: 'center' }}>
                {i > 0 && <span style={{ width: 14, height: 3, background: 'linear-gradient(180deg,#485866,#28323d)' }} />}
                {taskId ? <Link to={`/tasks/${taskId}`} style={{ display: 'flex' }}>{node}</Link> : node}
              </span>
            )
          })}
        </div>
        <span className="wl-mono" style={{ marginLeft: 'auto', fontSize: 9.5, color: '#5d6e7e' }}>
          {new Date(run.started_at.endsWith('Z') ? run.started_at : run.started_at + 'Z').toLocaleTimeString()}
        </span>
        {run.status === 'running' && (
          <button
            className="wl-mono"
            style={{ background: 'none', border: '1px solid rgba(178,86,68,.6)', borderRadius: 2, color: '#dd8471', fontSize: 9, letterSpacing: 1, padding: '2px 7px', cursor: 'pointer' }}
            onClick={() => post(`/api/pipelines/runs/${run.id}/cancel`).catch(() => {})}
          >
            ABORT
          </button>
        )}
      </div>
      {run.error && <div className="wl-mono" style={{ marginTop: 6, fontSize: 10, color: '#dd8471' }}>{run.error}</div>}
    </div>
  )
}

export default function Orchestrator() {
  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const livePipelineRuns = useStore((s) => s.pipelineRuns)

  const refresh = useCallback(() => {
    get<Pipeline[]>('/api/pipelines').then(setPipelines)
    get<Profile[]>('/api/profiles').then(setProfiles)
    get<Run[]>('/api/pipelines/runs/recent').then(setRuns)
  }, [])

  useEffect(refresh, [refresh])

  const refreshRuns = useCallback(() => {
    get<Run[]>('/api/pipelines/runs/recent').then(setRuns)
  }, [])

  // merge live WS updates over REST snapshot
  const mergedRuns: Run[] = runs.map((r) => ({ ...r, ...(livePipelineRuns[r.id] ?? {}) }))
  for (const live of Object.values(livePipelineRuns) as Run[]) {
    if (!mergedRuns.some((r) => r.id === live.id)) {
      mergedRuns.unshift({ ...live, pipeline_name: pipelines.find((p) => p.id === live.pipeline_id)?.name })
    }
  }
  mergedRuns.sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''))

  async function addPipeline() {
    await post<Pipeline>('/api/pipelines', {
      name: `Pipeline ${pipelines.length + 1}`,
      stages: [
        { name: 'Research', prompt: 'Research the topic thoroughly. Produce structured findings.', profile_id: null, model: null, kind: 'general' },
        { name: 'Execute', prompt: 'Act on the findings from the previous stage.', profile_id: null, model: null, kind: 'general' },
      ],
    })
    refresh()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="wl-sectionlabel">Orchestration Pipelines</span>
        <div className="wl-divider" style={{ flex: 1 }} />
        <span className="wl-mono" style={{ fontSize: 10, color: '#8fa0b0' }}>
          CHAIN AGENTS · EACH STAGE HANDS ITS OUTPUT TO THE NEXT
        </span>
        <div className="wl-btn-housing">
          <button className="wl-btn wl-btn--steel" onClick={addPipeline}>+ NEW PIPELINE</button>
        </div>
      </div>

      {pipelines.map((p, i) => (
        <PipelinePanel
          key={p.id}
          pipeline={p}
          profiles={profiles}
          lastRun={mergedRuns.find((r) => r.pipeline_id === p.id)}
          rusty={i % 2 === 1}
          refresh={refresh}
          refreshRuns={refreshRuns}
        />
      ))}
      {pipelines.length === 0 && (
        <div className="wl-tile wl-tile--inset" style={{ padding: '36px 16px', textAlign: 'center' }}>
          <span className="wl-mono" style={{ fontSize: 11, color: '#8fa0b0' }}>
            NO PIPELINES ON THE BOARD. Bolt one together and chain Research → Draft → Review agents.
          </span>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
        <span className="wl-sectionlabel">Run History</span>
        <div className="wl-divider" style={{ flex: 1 }} />
        <span className="wl-mono" style={{ fontSize: 10, color: '#8fa0b0' }}>{mergedRuns.length} LOGGED</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {mergedRuns.slice(0, 15).map((r) => <RunRow key={r.id} run={r} />)}
        {mergedRuns.length === 0 && (
          <span className="wl-mono" style={{ fontSize: 11, color: '#5d6e7e', padding: '4px 2px' }}>NO RUNS YET.</span>
        )}
      </div>
    </div>
  )
}
