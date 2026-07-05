import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { get, post } from '../lib/api'
import type { Task, TaskEvent } from '../lib/types'
import { ACTIVE_STATUSES } from '../lib/types'
import { useStore } from '../store'
import { wsClient } from '../lib/ws'
import StatusPill from '../components/StatusPill'

export default function TaskDetail() {
  const { id = '' } = useParams()
  const task = useStore((s) => s.tasks[id])
  const events = useStore((s) => s.taskEvents[id] ?? [])
  const upsertTask = useStore((s) => s.upsertTask)
  const setEvents = useStore((s) => s.setEvents)
  const [message, setMessage] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)

  const isActive = task && ACTIVE_STATUSES.includes(task.status)

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

  async function cancel() {
    await post(`/api/tasks/${id}/cancel`).catch(() => {})
  }

  async function sendMessage() {
    if (!message.trim()) return
    await post(`/api/tasks/${id}/message`, { text: message.trim() })
    setMessage('')
  }

  const rendered = useMemo(() => renderEvents(events), [events])

  if (!task) return <div className="p-6 text-sm text-ink-dim">Loading…</div>

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-edge bg-panel px-4 py-3 md:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-sm font-bold text-ink">{task.title}</h1>
          <StatusPill status={task.status} />
          <span className="font-mono text-xs text-ink-dim">
            ~${(task.total_cost_usd ?? 0).toFixed(3)} · {((task.input_tokens + task.output_tokens) / 1000).toFixed(1)}k tok
            {task.num_turns != null && ` · ${task.num_turns} turns`}
          </span>
          <div className="ml-auto flex gap-2">
            {isActive && (
              <button
                className="rounded-md border border-err/50 px-3 py-1 text-xs font-semibold text-err hover:bg-err/10"
                onClick={cancel}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
        {task.error && <div className="mt-2 whitespace-pre-wrap font-mono text-xs text-err">{task.error}</div>}
      </div>

      <div
        className="flex-1 overflow-y-auto px-4 py-3 md:px-6"
        onScroll={(e) => {
          const el = e.currentTarget
          setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
        }}
      >
        <div className="mx-auto max-w-3xl space-y-2 pb-4">
          {rendered}
          {task.status === 'running' && (
            <span className="stream-cursor inline-block h-4 w-2 bg-accent align-text-bottom" />
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {isActive && task.status !== 'queued' && (
        <div className="border-t border-edge bg-panel p-3 md:px-6">
          <div className="mx-auto flex max-w-3xl gap-2">
            <input
              className="flex-1 rounded-md border border-edge bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
              placeholder="Send a message to the agent…"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
            />
            <button
              className="rounded-md bg-accent/90 px-4 py-2 text-sm font-semibold text-black hover:bg-accent disabled:opacity-50"
              disabled={!message.trim()}
              onClick={sendMessage}
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---- event rendering --------------------------------------------------------

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
          <div key={key} className="event-in whitespace-pre-wrap rounded-lg bg-panel px-3 py-2 text-sm leading-relaxed text-ink">
            {e.payload.text}
          </div>,
        )
        break
      case 'thinking':
        out.push(
          <div key={key} className="event-in whitespace-pre-wrap px-3 py-1 font-mono text-xs italic text-ink-dim/70">
            {e.payload.text}
          </div>,
        )
        break
      case 'tool_use':
        out.push(<ToolCall key={key} event={e} result={resultsByToolId[e.payload.tool_use_id]} />)
        break
      case 'status_change':
        out.push(
          <div key={key} className="event-in px-1 py-0.5 text-center font-mono text-[11px] uppercase tracking-widest text-ink-dim/60">
            — {e.payload.to} —
          </div>,
        )
        break
      case 'verify_output':
        out.push(
          <div
            key={key}
            className={`event-in whitespace-pre-wrap px-3 font-mono text-xs ${
              e.payload.stream === 'status'
                ? e.payload.exit_code === 0 ? 'font-bold text-ok' : 'font-bold text-err'
                : e.payload.stream === 'cmd' ? 'text-violet' : 'text-ink-dim'
            }`}
          >
            {e.payload.line}
          </div>,
        )
        break
      case 'approval_requested':
        out.push(
          <div key={key} className="event-in rounded-lg border border-warn/40 bg-warn/5 px-3 py-2 font-mono text-xs text-warn">
            ⏸ approval requested: {e.payload.tool} {shortInput(e.payload.input)}
          </div>,
        )
        break
      case 'approval_resolved':
        out.push(
          <div key={key} className="event-in px-3 font-mono text-[11px] text-ink-dim">
            {e.payload.resolution === 'auto_approved' ? '✓ auto-approved' : `● ${e.payload.resolution}`}: {e.payload.tool}
            {e.payload.input ? ` ${shortInput(e.payload.input)}` : ''}
          </div>,
        )
        break
      case 'user_message':
        out.push(
          <div key={key} className="event-in rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-sm text-ink">
            <span className="mr-2 font-mono text-[10px] uppercase tracking-widest text-accent">you</span>
            {e.payload.text}
          </div>,
        )
        break
      case 'result':
        out.push(
          <div key={key} className={`event-in rounded-lg border px-3 py-2 text-sm ${e.payload.is_error ? 'border-err/40 bg-err/5' : 'border-ok/30 bg-ok/5'}`}>
            <div className="font-mono text-[10px] uppercase tracking-widest text-ink-dim">
              result · {e.payload.subtype} · ~${(e.payload.total_cost_usd ?? 0).toFixed(3)} · {e.payload.num_turns} turns
            </div>
            {e.payload.text && <div className="mt-1 whitespace-pre-wrap text-ink">{e.payload.text}</div>}
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
    <div className="event-in overflow-hidden rounded-lg border border-edge bg-panel-2/60">
      <button
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs hover:bg-panel-2"
        onClick={() => setOpen(!open)}
      >
        <span className={failed ? 'text-err' : result ? 'text-ok' : 'text-warn'}>
          {failed ? '✗' : result ? '✓' : '▸'}
        </span>
        <span className="font-semibold text-accent">{p.tool}</span>
        <span className="truncate text-ink-dim">{shortInput(p.input)}</span>
        <span className="ml-auto text-ink-dim/60">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="border-t border-edge px-3 py-2">
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-ink-dim">
            {JSON.stringify(p.input, null, 2)}
          </pre>
          {result && (
            <pre className={`mt-2 max-h-64 overflow-auto whitespace-pre-wrap border-t border-edge/50 pt-2 font-mono text-[11px] ${failed ? 'text-err' : 'text-ink-dim'}`}>
              {result.payload.content || '(no output)'}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
