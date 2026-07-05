import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { get, post } from '../lib/api'
import type { Task, TaskEvent } from '../lib/types'
import { ACTIVE_STATUSES } from '../lib/types'
import { useStore } from '../store'
import { wsClient } from '../lib/ws'

const NO_EVENTS: TaskEvent[] = [] // stable ref — an inline `?? []` makes zustand's snapshot unstable and crashes the view

// phosphor palette
const PHOS_DIM = '#57a273'
const PHOS_BLUE = '#7fc3e8'
const PHOS_RED = '#dd8471'
const PHOS_YELLOW = '#e8c14a'
const PHOS_FAINT = '#3f6a4e'

function badgeFor(status: string): { cls: string; label: string } {
  switch (status) {
    case 'done': return { cls: 'wl-badge--done', label: 'DONE' }
    case 'running': return { cls: 'wl-badge--running', label: 'RUNNING' }
    case 'failed': return { cls: 'wl-badge--failed', label: 'FAILED' }
    case 'queued': return { cls: 'wl-badge--queued', label: 'QUEUED' }
    case 'cancelled': return { cls: 'wl-badge--cancelled', label: 'CANCELLED' }
    case 'awaiting_approval': return { cls: 'wl-badge--running', label: 'AWAITING APPROVAL' }
    case 'waiting_input': return { cls: 'wl-badge--running', label: 'WAITING INPUT' }
    case 'verifying': return { cls: 'wl-badge--running', label: 'VERIFYING' }
    default: return { cls: 'wl-badge--queued', label: status.toUpperCase() }
  }
}

const smallBtn: React.CSSProperties = { fontSize: 10, padding: '6px 12px', letterSpacing: 1.5 }
const pressedSteel: React.CSSProperties = {
  transform: 'translateY(0)',
  background: 'linear-gradient(180deg, #3d4a58, #2b3742)',
  boxShadow: '0 2px 0 -1px #171d23, 0 2px 0 0 #0b0f13, 0 3px 4px rgba(0,0,0,.4), inset 0 2px 4px rgba(0,0,0,.45)',
  color: PHOS_YELLOW,
}

export default function TaskDetail() {
  const { id = '' } = useParams()
  const task = useStore((s) => s.tasks[id])
  const events = useStore((s) => s.taskEvents[id] ?? NO_EVENTS)
  const upsertTask = useStore((s) => s.upsertTask)
  const setEvents = useStore((s) => s.setEvents)
  const [message, setMessage] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [tab, setTab] = useState<'stream' | 'diff'>('stream')
  const [diff, setDiff] = useState<string | null>(null)
  const [actionMsg, setActionMsg] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  const isActive = task && ACTIVE_STATUSES.includes(task.status)
  const isTerminal = task && !ACTIVE_STATUSES.includes(task.status)
  const isRepo = task?.kind === 'repo'
  const hasWorktree = isRepo && !!task?.worktree_path

  useEffect(() => {
    get<Task>(`/api/tasks/${id}`).then(upsertTask).catch(() => {})
    wsClient.subscribe(`task:${id}`)
    const resync = () => {
      get<TaskEvent[]>(`/api/tasks/${id}/events`).then((evs) => setEvents(id, evs))
    }
    window.addEventListener('agentos:resync', resync)
    return () => {
      wsClient.unsubscribe(`task:${id}`)
      window.removeEventListener('agentos:resync', resync)
    }
  }, [id, upsertTask, setEvents])

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: 'instant' as ScrollBehavior })
  }, [events.length, autoScroll])

  useEffect(() => {
    if (tab === 'diff' && isRepo) {
      get<{ diff: string }>(`/api/tasks/${id}/diff`).then((d) => setDiff(d.diff))
    }
  }, [tab, id, isRepo, task?.status])

  async function cancel() {
    await post(`/api/tasks/${id}/cancel`).catch(() => {})
  }

  async function sendMessage() {
    if (!message.trim()) return
    await post(`/api/tasks/${id}/message`, { text: message.trim() })
    setMessage('')
  }

  async function retry() {
    const child = await post<Task>(`/api/tasks/${id}/retry`)
    navigate(`/tasks/${child.id}`)
  }

  async function worktreeAction(action: 'merge' | 'discard') {
    if (action === 'discard' && !window.confirm('Discard all of this task’s changes and delete its branch?')) return
    setActionMsg('')
    try {
      const res = await post<{ message: string }>(`/api/tasks/${id}/worktree/${action}`)
      setActionMsg(res.message)
      get<Task>(`/api/tasks/${id}`).then(upsertTask)
    } catch (e: any) {
      setActionMsg(e.message ?? `${action} failed`)
    }
  }

  const rendered = useMemo(() => renderEvents(events), [events])

  if (!task) {
    return (
      <div className="wl-mono p-6" style={{ fontSize: 12, color: '#8fa0b0', letterSpacing: 1 }}>
        LOADING TASK RECORD…
      </div>
    )
  }

  const badge = badgeFor(task.status)

  return (
    <div className="flex h-full flex-col gap-3 p-3 md:p-4">
      {/* ---- header strip: steel equipment panel ---- */}
      <div className="wl-equip wl-rust-tr" style={{ padding: '12px 26px 10px', flexShrink: 0 }}>
        <span className="wl-screw wl-screw--tl" />
        <span className="wl-screw wl-screw--rusty wl-screw--tr" />
        <span className="wl-screw wl-screw--bl" />
        <span className="wl-screw wl-screw--br" />
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="wl-engraved" style={{ fontSize: 14 }}>{task.title}</h1>
          <span className={`wl-badge ${badge.cls}`}>{badge.label}</span>
          <span className="wl-mono" style={{ fontSize: 10, color: '#8fa0b0', letterSpacing: 1 }}>
            ~${(task.total_cost_usd ?? 0).toFixed(3)} · {((task.input_tokens + task.output_tokens) / 1000).toFixed(1)}k tok
            {task.num_turns != null && ` · ${task.num_turns} turns`}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {isActive && (
              <button className="wl-btn wl-btn--steel" style={{ ...smallBtn, color: PHOS_RED }} onClick={cancel}>
                CANCEL
              </button>
            )}
            {isTerminal && (
              <button className="wl-btn wl-btn--steel" style={smallBtn} onClick={retry}>
                ↻ RETRY
              </button>
            )}
            {isTerminal && hasWorktree && (
              <>
                <button className="wl-btn" style={smallBtn} onClick={() => worktreeAction('merge')}>
                  MERGE
                </button>
                <button className="wl-btn wl-btn--steel" style={smallBtn} onClick={() => worktreeAction('discard')}>
                  DISCARD
                </button>
              </>
            )}
          </div>
        </div>
        {isRepo && (
          <div className="mt-2 flex items-center gap-4">
            <div className="wl-btn-housing" style={{ display: 'inline-flex', gap: 6 }}>
              {(['stream', 'diff'] as const).map((t) => (
                <button
                  key={t}
                  className="wl-btn wl-btn--steel"
                  style={{ fontSize: 9, padding: '4px 12px', letterSpacing: 2, ...(tab === t ? pressedSteel : {}) }}
                  onClick={() => setTab(t)}
                >
                  {t.toUpperCase()}
                </button>
              ))}
            </div>
            {task.branch && (
              <span className="wl-mono" style={{ fontSize: 10, color: '#8fa0b0' }}>⎇ {task.branch}</span>
            )}
          </div>
        )}
        {actionMsg && (
          <div className="wl-mono mt-2" style={{ fontSize: 11, color: PHOS_YELLOW }}>{actionMsg}</div>
        )}
        {task.error && (
          <div className="wl-mono mt-2 whitespace-pre-wrap" style={{ fontSize: 11, color: PHOS_RED }}>{task.error}</div>
        )}
      </div>

      {/* ---- CRT monitor: stream / diff ---- */}
      <div className="flex min-h-0 flex-1">
        <div className="wl-monitor-bezel flex flex-1" style={{ minHeight: 0 }}>
          {tab === 'diff' ? (
            <div className="wl-crt flex flex-1 flex-col" style={{ minWidth: 0, padding: '14px 16px 16px', fontSize: 12 }}>
              <div className="wl-scanlines" />
              <div className="wl-glare" />
              <div className="wl-glare wl-glare--low" />
              <div className="wl-scanbar" />
              <div className="relative flex-1 overflow-y-auto" style={{ minHeight: 0, padding: '2px 6px 4px' }}>
                <DiffView diff={diff} />
              </div>
            </div>
          ) : (
            <div className="wl-crt wl-power-on flex flex-1 flex-col" style={{ minWidth: 0, padding: '14px 16px 16px', fontSize: 12 }}>
              <div className="wl-scanlines" />
              <div className="wl-glare" />
              <div className="wl-glare wl-glare--low" />
              <div className="wl-scanbar" />
              <div
                className="relative flex-1 overflow-y-auto"
                style={{ minHeight: 0, padding: '2px 6px 4px' }}
                onScroll={(e) => {
                  const el = e.currentTarget
                  setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
                }}
              >
                <div className="mx-auto max-w-3xl space-y-2 pb-4">
                  {rendered}
                  {task.status === 'running' && <span className="wl-cursor" />}
                  <div ref={bottomRef} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ---- follow-up transmit row ---- */}
      {isActive && task.status !== 'queued' && (
        <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
          <input
            className="wl-input flex-1"
            placeholder="TRANSMIT TO AGENT…"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
          />
          <div className="wl-btn-housing">
            <button
              className="wl-btn"
              style={{ opacity: message.trim() ? 1 : 0.5 }}
              disabled={!message.trim()}
              onClick={sendMessage}
            >
              SEND ▸
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function DiffView({ diff }: { diff: string | null }) {
  if (diff === null) return <div style={{ color: PHOS_DIM, fontSize: 12 }}>LOADING DIFF…<span className="wl-cursor" /></div>
  if (!diff.trim()) return <div style={{ color: PHOS_DIM, fontSize: 12 }}>— NO CHANGES —</div>
  return (
    <pre className="overflow-x-auto whitespace-pre" style={{ fontSize: 11, lineHeight: 1.6 }}>
      {diff.split('\n').map((line, i) => {
        const isFileHeader = line.startsWith('+++') || line.startsWith('---')
        const cls = line.startsWith('+') && !isFileHeader ? 'wl-crt-text' : ''
        const style: React.CSSProperties = isFileHeader
          ? { color: PHOS_BLUE, fontWeight: 700 }
          : line.startsWith('@@')
            ? { color: PHOS_BLUE }
            : line.startsWith('+')
              ? {}
              : line.startsWith('-')
                ? { color: PHOS_RED }
                : line.startsWith('diff ')
                  ? { color: PHOS_BLUE, fontWeight: 700, marginTop: 12, borderTop: `1px solid ${PHOS_FAINT}`, paddingTop: 8 }
                  : { color: PHOS_DIM }
        return (
          <span key={i} className={`block ${cls}`} style={style}>
            {line || ' '}
          </span>
        )
      })}
    </pre>
  )
}

// ---- event rendering (phosphor terminal lines) -------------------------------

function renderEvents(events: TaskEvent[]) {
  const out: React.ReactNode[] = []
  const resultsByToolId: Record<string, TaskEvent> = {}
  for (const e of events) {
    if (e.type === 'tool_result') resultsByToolId[e.payload.tool_use_id] = e
  }
  for (const e of events) {
    const key = `${e.task_id}-${e.seq}`
    switch (e.type) {
      case 'assistant_text':
        out.push(
          <div key={key} className="event-in wl-crt-text whitespace-pre-wrap py-1" style={{ fontSize: 12, lineHeight: 1.6 }}>
            {e.payload.text}
          </div>,
        )
        break
      case 'thinking':
        out.push(
          <div key={key} className="event-in whitespace-pre-wrap italic" style={{ fontSize: 11, color: PHOS_DIM, opacity: 0.8 }}>
            {e.payload.text}
          </div>,
        )
        break
      case 'tool_use':
        out.push(<ToolCall key={key} event={e} result={resultsByToolId[e.payload.tool_use_id]} />)
        break
      case 'status_change':
        out.push(
          <div key={key} className="event-in py-0.5 text-center uppercase" style={{ fontSize: 10, letterSpacing: 3, color: PHOS_FAINT }}>
            — {e.payload.to} —
          </div>,
        )
        break
      case 'verify_output':
        out.push(
          <div
            key={key}
            className={`event-in whitespace-pre-wrap ${e.payload.stream === 'status' && e.payload.exit_code === 0 ? 'wl-crt-text' : ''}`}
            style={{
              fontSize: 11,
              ...(e.payload.stream === 'status'
                ? e.payload.exit_code === 0
                  ? { fontWeight: 700 }
                  : { fontWeight: 700, color: PHOS_RED }
                : e.payload.stream === 'cmd'
                  ? { color: PHOS_BLUE }
                  : { color: PHOS_DIM }),
            }}
          >
            {e.payload.stream === 'cmd' ? `$ ${e.payload.line}` : e.payload.line}
          </div>,
        )
        break
      case 'approval_requested':
        out.push(
          <div key={key} className="event-in" style={{ fontSize: 11, color: PHOS_YELLOW, textShadow: '0 0 6px rgba(232,193,74,.4)', animation: 'wl-blink 1.4s infinite' }}>
            ⏸ APPROVAL REQUESTED: {e.payload.tool} {shortInput(e.payload.input)}
          </div>,
        )
        break
      case 'approval_resolved':
        out.push(
          <div key={key} className="event-in" style={{ fontSize: 10.5, color: PHOS_YELLOW, opacity: 0.75 }}>
            {e.payload.resolution === 'auto_approved' ? '✓ auto-approved' : `● ${e.payload.resolution}`}: {e.payload.tool}
            {e.payload.input ? ` ${shortInput(e.payload.input)}` : ''}
          </div>,
        )
        break
      case 'user_message':
        out.push(
          <div key={key} className="event-in whitespace-pre-wrap py-0.5" style={{ fontSize: 12, color: PHOS_YELLOW, textShadow: '0 0 6px rgba(232,193,74,.35)' }}>
            OVERSEER&gt; {e.payload.text}
          </div>,
        )
        break
      case 'result':
        out.push(
          <div key={key} className="event-in py-1">
            <div className={e.payload.is_error ? '' : 'wl-crt-text'} style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, ...(e.payload.is_error ? { color: PHOS_RED, textShadow: '0 0 6px rgba(221,132,113,.45)' } : {}) }}>
              ═══ RESULT · {e.payload.subtype} · ~${(e.payload.total_cost_usd ?? 0).toFixed(3)} ═══
            </div>
            {e.payload.text && (
              <div className="wl-crt-text mt-1 whitespace-pre-wrap" style={{ fontSize: 12, lineHeight: 1.6 }}>
                {e.payload.text}
              </div>
            )}
          </div>,
        )
        break
    }
  }
  return out
}

function shortInput(input: Record<string, any> | undefined): string {
  if (!input) return ''
  const s = input.command ?? input.file_path ?? JSON.stringify(input)
  return typeof s === 'string' ? (s.length > 120 ? s.slice(0, 120) + '…' : s) : ''
}

function ToolCall({ event, result }: { event: TaskEvent; result?: TaskEvent }) {
  const [open, setOpen] = useState(false)
  const p = event.payload
  const failed = result?.payload.is_error
  return (
    <div className="event-in">
      <button
        className="flex w-full items-center gap-2 text-left"
        style={{ fontSize: 11, background: 'none', border: 'none', cursor: 'pointer', color: PHOS_DIM, fontFamily: 'inherit', padding: '1px 0' }}
        onClick={() => setOpen(!open)}
      >
        <span className={failed ? '' : result ? 'wl-crt-text' : ''} style={failed ? { color: PHOS_RED } : result ? {} : { color: PHOS_YELLOW }}>
          {failed ? '✗' : result ? '✓' : '▸'}
        </span>
        <span className="wl-crt-text" style={{ fontWeight: 600 }}>{p.tool}</span>
        <span className="truncate" style={{ color: PHOS_DIM }}>{shortInput(p.input)}</span>
        <span className="ml-auto" style={{ color: PHOS_FAINT }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div style={{ borderLeft: `1px solid ${PHOS_FAINT}`, marginLeft: 3, paddingLeft: 10, marginTop: 2 }}>
          <pre className="overflow-x-auto whitespace-pre-wrap" style={{ fontSize: 10.5, color: PHOS_DIM }}>
            {JSON.stringify(p.input, null, 2)}
          </pre>
          {result && (
            <pre
              className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap"
              style={{ fontSize: 10.5, color: failed ? PHOS_RED : PHOS_DIM, borderTop: `1px solid ${PHOS_FAINT}`, paddingTop: 6 }}
            >
              {result.payload.content || '(no output)'}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
