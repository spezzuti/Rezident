import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { get, post } from '../lib/api'
import type { Task, TaskEvent } from '../lib/types'
import { ACTIVE_STATUSES } from '../lib/types'
import { useStore } from '../store'
import { wsClient } from '../lib/ws'

export default function Chat() {
  const { id } = useParams()
  const tasks = useStore((s) => s.tasks)
  const events = useStore((s) => s.taskEvents[id ?? ''] ?? [])
  const setTasks = useStore((s) => s.setTasks)
  const upsertTask = useStore((s) => s.upsertTask)
  const setEvents = useStore((s) => s.setEvents)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [agents, setAgents] = useState<{ id: string; name: string; icon: string; color: string; role: string; is_default: number | boolean }[]>([])
  const [agentId, setAgentId] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  const chat = id ? tasks[id] : undefined
  const chats = Object.values(tasks)
    .filter((t) => t.kind === 'chat')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  const isLive = chat && ACTIVE_STATUSES.includes(chat.status)
  const thinking = chat?.status === 'running'

  useEffect(() => {
    get<Task[]>('/api/tasks').then(setTasks)
    get<typeof agents>('/api/profiles').then((list) => {
      setAgents(list)
      const def = list.find((a) => a.is_default)
      if (def) setAgentId((cur) => cur || def.id)
    })
  }, [setTasks])

  useEffect(() => {
    if (!id) return
    get<Task>(`/api/tasks/${id}`).then(upsertTask).catch(() => {})
    wsClient.subscribe(`task:${id}`)
    const resync = () => get<TaskEvent[]>(`/api/tasks/${id}/events`).then((evs) => setEvents(id, evs))
    window.addEventListener('agentos:resync', resync)
    return () => {
      wsClient.unsubscribe(`task:${id}`)
      window.removeEventListener('agentos:resync', resync)
    }
  }, [id, upsertTask, setEvents])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' as ScrollBehavior })
  }, [events.length])

  async function send() {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    try {
      if (!id) {
        const agent = agents.find((a) => a.id === agentId)
        const task = await post<Task>('/api/tasks', {
          title: `${agent ? agent.icon + ' ' + agent.name + ' · ' : ''}${text.slice(0, 48)}`,
          prompt: text,
          kind: 'chat',
          profile_id: agentId || null,
        })
        upsertTask(task)
        navigate(`/chat/${task.id}`)
      } else {
        await post(`/api/tasks/${id}/message`, { text })
      }
      setDraft('')
    } catch (e: any) {
      alert(e.message ?? 'send failed')
    } finally {
      setSending(false)
    }
  }

  const bubbles = useMemo(() => renderChat(events), [events])

  return (
    <div className="flex h-full">
      {/* channel list */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-edge md:flex">
        <div className="flex items-center justify-between px-3 py-3">
          <span className="hud-label">Channels</span>
          <Link
            to="/chat"
            className="rounded border border-accent/40 px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-accent hover:bg-accent/10"
          >
            + new
          </Link>
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
          {chats.map((c) => (
            <Link
              key={c.id}
              to={`/chat/${c.id}`}
              className={`block rounded-md border px-2.5 py-2 transition-colors ${
                c.id === id ? 'border-accent/40 bg-accent/10' : 'border-transparent hover:border-edge hover:bg-panel-2/60'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  ACTIVE_STATUSES.includes(c.status) ? 'bg-ok dot-running' : 'bg-ink-dimmer'
                }`} />
                <span className="truncate text-xs font-semibold text-ink-2">{c.title}</span>
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-ink-dim">
                ~${(c.total_cost_usd ?? 0).toFixed(3)} · {ACTIVE_STATUSES.includes(c.status) ? 'live' : 'ended'}
              </div>
            </Link>
          ))}
          {chats.length === 0 && (
            <div className="px-2 py-6 text-center font-mono text-[11px] text-ink-dimmer">no channels yet</div>
          )}
        </div>
      </aside>

      {/* conversation */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="glass !rounded-none border-b border-edge px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="font-mono text-sm font-bold" style={{ color: '#34d399', textShadow: '0 0 14px rgba(52,211,153,0.6)' }}>⌁ COMMS</span>
            {chat ? (
              <>
                <span className="truncate text-sm text-ink-2">{chat.title}</span>
                <span className="font-mono text-[11px] text-ink-dim">~${(chat.total_cost_usd ?? 0).toFixed(3)}</span>
                {isLive && (
                  <button
                    className="ml-auto rounded-md border border-err/50 px-3 py-1 font-mono text-[10px] font-bold uppercase text-err hover:bg-err/10"
                    onClick={() => post(`/api/tasks/${id}/cancel`).catch(() => {})}
                  >
                    end session
                  </button>
                )}
              </>
            ) : (
              <span className="text-sm text-ink-dim">open a direct line to an agent</span>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="mx-auto max-w-3xl space-y-3">
            {!id && (
              <div className="glass hud-corner mx-auto mt-8 max-w-lg p-6">
                <div className="neon-text text-center font-mono text-lg text-accent">⌁ open a channel</div>
                <div className="mt-2 text-center text-sm text-ink-2">
                  Pick who answers. The session stays alive between messages — your agent can read files,
                  search, and (with your approval) act.
                </div>
                <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {agents.map((a) => (
                    <button
                      key={a.id}
                      className={`flex items-center gap-3 rounded-lg border p-2.5 text-left transition-all ${
                        agentId === a.id ? 'bg-panel-2' : 'border-edge hover:border-accent/30'
                      }`}
                      style={agentId === a.id ? { borderColor: a.color, boxShadow: `0 0 18px ${a.color}44` } : undefined}
                      onClick={() => setAgentId(a.id)}
                    >
                      <span className="flex h-9 w-9 items-center justify-center rounded-lg border text-lg"
                            style={{ color: a.color, borderColor: `${a.color}55`, background: `${a.color}11`, textShadow: `0 0 14px ${a.color}` }}>
                        {a.icon}
                      </span>
                      <span className="min-w-0">
                        <span className="block font-mono text-xs font-bold" style={{ color: a.color }}>{a.name}</span>
                        <span className="block truncate text-[10px] text-ink-dim">{a.role || 'generalist'}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {bubbles}
            {thinking && (
              <div className="event-in flex items-center gap-2 px-2 font-mono text-xs text-accent">
                <span className="stream-cursor inline-block h-3.5 w-2 bg-accent" />
                processing…
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        <div className="border-t border-edge p-3 md:px-6">
          <div className="mx-auto flex max-w-3xl gap-2">
            <textarea
              rows={draft.includes('\n') ? 3 : 1}
              className="flex-1 resize-none rounded-md border border-edge bg-input px-3 py-2.5 text-sm text-ink outline-none transition-shadow focus:border-accent/50 focus:shadow-[0_0_20px_rgba(127,200,255,0.12)]"
              placeholder={chat && !isLive ? 'session ended — start a new channel' : 'transmit to agent… (Enter to send)'}
              disabled={Boolean(chat && !isLive) || sending}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
            />
            <button
              className="rounded-md px-5 font-mono text-xs font-bold uppercase tracking-widest text-bg transition-all hover:shadow-[0_0_24px_rgba(52,211,153,0.4)] disabled:opacity-40"
              style={{ background: '#34d399' }}
              disabled={!draft.trim() || sending || Boolean(chat && !isLive)}
              onClick={send}
            >
              send
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function renderChat(events: TaskEvent[]) {
  const out: React.ReactNode[] = []
  for (const e of events) {
    const key = `${e.task_id}-${e.seq}`
    if (e.type === 'user_message') {
      out.push(
        <div key={key} className="event-in flex justify-end">
          <div className="max-w-[80%] rounded-2xl rounded-br-sm border border-accent/30 bg-accent/10 px-4 py-2.5 text-sm text-ink">
            {e.payload.text}
          </div>
        </div>,
      )
    } else if (e.type === 'assistant_text') {
      out.push(
        <div key={key} className="event-in flex">
          <div className="glass max-w-[85%] rounded-2xl rounded-bl-sm px-4 py-2.5 text-sm leading-relaxed text-ink whitespace-pre-wrap">
            {e.payload.text}
          </div>
        </div>,
      )
    } else if (e.type === 'tool_use') {
      out.push(
        <div key={key} className="event-in px-2 font-mono text-[11px] text-ink-dim">
          <span className="text-accent">▸ {e.payload.tool}</span>{' '}
          {String(e.payload.input?.command ?? e.payload.input?.file_path ?? e.payload.input?.pattern ?? '').slice(0, 90)}
        </div>,
      )
    } else if (e.type === 'approval_requested') {
      out.push(
        <Link key={key} to="/approvals" className="event-in block rounded-lg border border-warn/40 bg-warn/5 px-3 py-2 font-mono text-xs text-warn hover:bg-warn/10">
          ⏸ agent wants to run {e.payload.tool} — tap to review in Approvals
        </Link>,
      )
    }
  }
  return out
}
