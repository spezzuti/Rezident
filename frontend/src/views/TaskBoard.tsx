import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { get, post } from '../lib/api'
import type { Task, TaskStatus } from '../lib/types'
import { useStore } from '../store'

const COLUMNS: { key: string; title: string; statuses: TaskStatus[] }[] = [
  { key: 'queued', title: 'Queued', statuses: ['queued'] },
  { key: 'running', title: 'Running', statuses: ['running', 'awaiting_approval', 'waiting_input'] },
  { key: 'verifying', title: 'Verifying', statuses: ['verifying'] },
  { key: 'done', title: 'Done', statuses: ['done'] },
  { key: 'failed', title: 'Failed / Cancelled', statuses: ['failed', 'cancelled'] },
]

/** Per-column tilt for the taped paper labels. */
const LABEL_ROT = [-1.4, 1, -0.8, 1.2, -1]

/** Pushpin color by status, used when the task has no agent_color. */
const STATUS_PIN: Record<TaskStatus, string> = {
  queued: '#8fa0b0',
  running: '#74dd8f',
  awaiting_approval: '#e8c14a',
  waiting_input: '#e8c14a',
  verifying: '#6db3d9',
  done: '#84b562',
  failed: '#dd8471',
  cancelled: '#5d6e7e',
}

function pinColor(t: Task): string {
  return t.agent_color || STATUS_PIN[t.status] || '#8fa0b0'
}

/** Deterministic slight rotation (±1.5deg) from the task id. */
function cardRot(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return (Math.abs(h) % 31) / 10 - 1.5
}

/** Drops that mean something:
 *  - active card → Failed column  = cancel the task
 *  - terminal card → Queued column = retry (spawns a fresh run)
 */
function dropAction(task: Task, columnKey: string): 'cancel' | 'retry' | null {
  const active = ['queued', 'running', 'awaiting_approval', 'waiting_input', 'verifying'].includes(task.status)
  if (active && columnKey === 'failed') return 'cancel'
  if (!active && columnKey === 'queued') return 'retry'
  return null
}

export default function TaskBoard() {
  const tasks = useStore((s) => s.tasks)
  const setTasks = useStore((s) => s.setTasks)
  const upsertTask = useStore((s) => s.upsertTask)
  const [dragTask, setDragTask] = useState<Task | null>(null)
  const [overCol, setOverCol] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    get<Task[]>('/api/tasks').then(setTasks)
  }, [setTasks])

  const all = Object.values(tasks)
    .filter((t) => t.kind !== 'chat')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))

  async function handleDrop(columnKey: string) {
    if (!dragTask) return
    const action = dropAction(dragTask, columnKey)
    setOverCol(null)
    setDragTask(null)
    if (action === 'cancel') {
      await post(`/api/tasks/${dragTask.id}/cancel`).catch(() => {})
    } else if (action === 'retry') {
      const child = await post<Task>(`/api/tasks/${dragTask.id}/retry`).catch(() => null)
      if (child) {
        upsertTask(child)
        navigate(`/tasks/${child.id}`)
      }
    }
  }

  return (
    <div style={{ minHeight: '100%', padding: '16px 20px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
      {/* the corkboard in its wooden frame, hung on the wall */}
      <div style={{ width: '100%', maxWidth: 1180, position: 'relative' }}>
        <div
          style={{
            borderRadius: 8,
            padding: 13,
            backgroundImage:
              'radial-gradient(ellipse 60px 20px at 6% 99%,rgba(50,26,12,.5),transparent 65%),linear-gradient(115deg,#7a5836,#5a3d22 60%,#4a3018)',
            border: '1px solid #10151a',
            boxShadow:
              '0 16px 30px rgba(0,0,0,.5),0 4px 8px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.15),inset 0 -2px 3px rgba(0,0,0,.4)',
            position: 'relative',
          }}
        >
          <span className="wl-screw" style={{ top: 5, left: 5 }} />
          <span className="wl-screw wl-screw--rusty" style={{ top: 5, right: 5 }} />
          <span className="wl-screw" style={{ bottom: 5, left: 5 }} />
          <span className="wl-screw" style={{ bottom: 5, right: 5 }} />
          {/* cork */}
          <div
            style={{
              borderRadius: 3,
              padding: '18px 16px 20px',
              backgroundColor: '#9c7650',
              backgroundImage:
                'radial-gradient(circle 2px at 20% 30%,rgba(60,40,20,.45),transparent 100%),radial-gradient(circle 1.5px at 70% 60%,rgba(255,230,190,.3),transparent 100%),radial-gradient(circle 2.5px at 40% 80%,rgba(60,40,20,.35),transparent 100%),radial-gradient(circle 1.5px at 85% 20%,rgba(60,40,20,.4),transparent 100%),radial-gradient(circle 2px at 55% 45%,rgba(255,230,190,.22),transparent 100%)',
              backgroundSize: '90px 70px,60px 50px,110px 90px,70px 80px,80px 60px',
              boxShadow: 'inset 0 3px 14px rgba(0,0,0,.45),inset 0 0 46px rgba(60,36,16,.35)',
              display: 'grid',
              gridTemplateColumns: 'repeat(5,minmax(0,1fr))',
              gap: 16,
              alignItems: 'start',
            }}
          >
            {COLUMNS.map((col, i) => {
              const items = all.filter((t) => col.statuses.includes(t.status))
              const legal = dragTask ? dropAction(dragTask, col.key) : null
              const isOver = overCol === col.key && !!legal
              return (
                <div
                  key={col.key}
                  onDragOver={(e) => {
                    if (legal) {
                      e.preventDefault()
                      setOverCol(col.key)
                    }
                  }}
                  onDragLeave={() => setOverCol((c) => (c === col.key ? null : c))}
                  onDrop={() => handleDrop(col.key)}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 14,
                    minWidth: 0,
                    minHeight: 230,
                    alignSelf: 'stretch',
                    borderRadius: 4,
                    outline: legal ? `2px dashed rgba(232,193,74,${isOver ? '.9' : '.45'})` : 'none',
                    outlineOffset: 3,
                    background: isOver ? 'rgba(255,235,190,.14)' : 'transparent',
                    transition: 'background .12s',
                  }}
                >
                  {/* taped column label */}
                  <div
                    style={{
                      transform: `rotate(${LABEL_ROT[i]}deg)`,
                      alignSelf: 'flex-start',
                      position: 'relative',
                      background: 'linear-gradient(170deg,#ece0c2,#ddceA5)',
                      padding: '5px 12px',
                      boxShadow: '0 2px 4px rgba(0,0,0,.35)',
                    }}
                  >
                    <span
                      style={{
                        position: 'absolute',
                        left: '50%',
                        top: -7,
                        width: 34,
                        height: 11,
                        transform: 'translateX(-50%) rotate(-2deg)',
                        background: 'linear-gradient(180deg,rgba(245,240,222,.55),rgba(232,224,198,.4))',
                        boxShadow: '0 1px 2px rgba(0,0,0,.2)',
                      }}
                    />
                    <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: 2, color: '#4a4230', textTransform: 'uppercase' }}>
                      {col.title}
                    </span>
                    <span className="wl-mono" style={{ fontSize: 9, color: '#8a7a58', marginLeft: 8 }}>{items.length}</span>
                  </div>

                  {isOver && (
                    <div
                      className="wl-mono"
                      style={{
                        border: '1px dashed rgba(60,40,20,.6)',
                        padding: '5px 6px',
                        textAlign: 'center',
                        fontSize: 9,
                        letterSpacing: 2,
                        textTransform: 'uppercase',
                        color: '#4a3018',
                        background: 'rgba(255,235,190,.25)',
                      }}
                    >
                      {legal === 'cancel' ? 'release to abort' : 'release to re-run'}
                    </div>
                  )}

                  {/* pinned index cards */}
                  {items.map((t) => (
                    <div
                      key={t.id}
                      draggable
                      onDragStart={() => setDragTask(t)}
                      onDragEnd={() => {
                        setDragTask(null)
                        setOverCol(null)
                      }}
                      onClick={() => navigate(`/tasks/${t.id}`)}
                      style={{
                        transform: `rotate(${cardRot(t.id)}deg)`,
                        position: 'relative',
                        backgroundImage:
                          'radial-gradient(ellipse 40px 26px at 100% 100%,rgba(120,100,60,.16),transparent 70%),linear-gradient(170deg,#f2ead0,#e6d9b4)',
                        padding: '15px 11px 10px',
                        boxShadow: '0 3px 7px rgba(0,0,0,.38),0 1px 2px rgba(0,0,0,.25)',
                        cursor: 'grab',
                        opacity: dragTask?.id === t.id ? 0.55 : 1,
                      }}
                    >
                      {/* pushpin */}
                      <span
                        style={{
                          position: 'absolute',
                          top: -5,
                          left: '50%',
                          marginLeft: -5,
                          width: 11,
                          height: 11,
                          borderRadius: '50%',
                          background: `radial-gradient(circle at 35% 30%, rgba(255,255,255,.55), ${pinColor(t)} 60%)`,
                          backgroundColor: pinColor(t),
                          boxShadow: '0 3px 4px rgba(0,0,0,.45),inset 0 1px 1px rgba(255,255,255,.45)',
                        }}
                      />
                      <div className="wl-mono" style={{ fontSize: 11.5, color: '#3a3426', wordBreak: 'break-word' }}>
                        {t.title}
                      </div>
                      <div
                        className="wl-mono"
                        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 9.5, color: '#8a7a58', marginTop: 6, minWidth: 0 }}
                      >
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {t.agent_icon ? `${t.agent_icon} ` : ''}
                          {t.agent_name ?? t.kind}
                        </span>
                        <span style={{ marginLeft: 'auto', flexShrink: 0 }}>~${t.total_cost_usd.toFixed(2)}</span>
                      </div>
                    </div>
                  ))}

                  {items.length === 0 && !isOver && (
                    <div
                      className="wl-mono"
                      style={{
                        border: '1px dashed rgba(60,40,20,.45)',
                        borderRadius: 3,
                        padding: '16px 8px',
                        textAlign: 'center',
                        fontSize: 9,
                        letterSpacing: 2,
                        textTransform: 'uppercase',
                        color: 'rgba(60,40,20,.55)',
                      }}
                    >
                      empty
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* drag semantics hint */}
      <div className="wl-mono" style={{ fontSize: 9.5, letterSpacing: 1, color: '#8fa0b0', textAlign: 'center' }}>
        drag an active card to <span style={{ color: '#dd8471' }}>FAILED</span> to abort · drag a finished card to{' '}
        <span style={{ color: '#dfd8c6' }}>QUEUED</span> to re-run
      </div>
    </div>
  )
}
