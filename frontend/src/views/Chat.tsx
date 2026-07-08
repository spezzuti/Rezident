import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { get, post } from '../lib/api'
import type { Task, TaskEvent } from '../lib/types'
import { ACTIVE_STATUSES } from '../lib/types'
import { useStore } from '../store'
import { wsClient } from '../lib/ws'
import { useIsMobile } from '../lib/mobile'

const NO_EVENTS: TaskEvent[] = [] // stable ref — an inline `?? []` makes zustand's snapshot unstable and crashes the view

/* unified roster entry (/api/agents): local Claude personas + bridged runtimes */
interface ChatAgent {
  id: string
  name: string
  icon: string
  color: string
  role: string
  kind: string
  profile_id: string | null
  integration_key: string | null
  available: boolean
}

const OPERATOR_AMBER = '#c2a13f'
const PHOS_DIM = '#57a273'
const TIME_GREEN = '#3f8f5e'

const fmtTime = (ts: string) =>
  new Date(ts.endsWith('Z') ? ts : ts + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export default function Chat() {
  const { id } = useParams()
  const tasks = useStore((s) => s.tasks)
  const events = useStore((s) => (id ? s.taskEvents[id] : undefined) ?? NO_EVENTS)
  const streamText = useStore((s) => (id ? s.streaming[id] : undefined) ?? '') // live ACP token stream
  const setTasks = useStore((s) => s.setTasks)
  const upsertTask = useStore((s) => s.upsertTask)
  const setEvents = useStore((s) => s.setEvents)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [agents, setAgents] = useState<ChatAgent[]>([])
  const [agentId, setAgentId] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const mobile = useIsMobile()

  const chat = id ? tasks[id] : undefined
  const chats = Object.values(tasks)
    .filter((t) => t.kind === 'chat')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  const isLive = chat && ACTIVE_STATUSES.includes(chat.status)
  const thinking = chat?.status === 'running'

  useEffect(() => {
    get<Task[]>('/api/tasks').then(setTasks)
    get<ChatAgent[]>('/api/agents').then((list) => {
      setAgents(list)
      const def = list.find((a) => a.kind === 'claude') || list[0]
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
  }, [events.length, streamText])

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
          profile_id: agent?.profile_id ?? null,
          integration_key: agent?.integration_key ?? null,
        })
        upsertTask(task)
        navigate(`/chat/${task.id}`)
      } else if (chat && !isLive) {
        // carrier lost — a fresh chat task with parent_task_id resumes the same
        // agent session server-side, so the channel re-opens with context intact
        const task = await post<Task>('/api/tasks', {
          title: ('↻ ' + chat.title.replace(/^(↻ )+/, '')).slice(0, 200),
          prompt: text,
          kind: 'chat',
          profile_id: chat.profile_id,
          integration_key: chat.integration_key,
          parent_task_id: chat.id,
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

  const pickedAgent = agents.find((a) => a.id === agentId)
  // for an open channel, resolve its agent from the roster (the DB join only names
  // Claude profiles — bridged runtimes are matched by integration_key)
  const chatAgent = chat?.integration_key
    ? agents.find((a) => a.integration_key === chat.integration_key)
    : chat?.profile_id
      ? agents.find((a) => a.profile_id === chat.profile_id)
      : undefined
  const agentName = (chat?.agent_name || chatAgent?.name || pickedAgent?.name || 'AGENT').toUpperCase()
  const log = useMemo(() => renderLog(events, agentName), [events, agentName])
  const inputDisabled = sending // dead channels stay writable — transmitting re-opens them

  return (
    <div style={{ display: 'grid', gridTemplateColumns: mobile ? 'minmax(0,1fr)' : '220px minmax(0,1fr)', gridTemplateRows: mobile ? 'auto minmax(0,1fr)' : undefined, gap: 12, alignItems: 'stretch', height: '100%' }}>
      {/* ---- CHANNELS rack ---- */}
      <div className="wl-equip" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0, maxHeight: mobile ? 172 : undefined }}>
        <span className="wl-screw wl-screw--tl" />
        <span className="wl-screw wl-screw--rusty wl-screw--br" />
        <div style={{ display: 'flex', alignItems: 'center', padding: '2px 6px' }}>
          <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: 2, color: '#dfd8c6' }}>CHANNELS</span>
          <Link
            to="/chat"
            className="wl-mono"
            style={{ marginLeft: 'auto', fontSize: 9, letterSpacing: 1, color: 'var(--wl-yellow)', textDecoration: 'none' }}
          >
            + NEW
          </Link>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {chats.map((c) => (
            <Link
              key={c.id}
              to={`/chat/${c.id}`}
              className={`wl-nav-item${c.id === id ? ' active' : ''}`}
              style={{ textDecoration: 'none', fontSize: 11 }}
            >
              <span
                className={`wl-led ${ACTIVE_STATUSES.includes(c.status) ? 'wl-led--green wl-led--blink' : 'wl-led--off'}`}
                style={{ flexShrink: 0 }}
              />
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
            </Link>
          ))}
          {chats.length === 0 && (
            <div className="wl-mono" style={{ padding: '18px 6px', textAlign: 'center', fontSize: 10, color: '#5d6e7e' }}>
              NO CHANNELS LOGGED
            </div>
          )}
        </div>
        <div style={{ marginTop: 'auto', display: 'flex', gap: 10, justifyContent: 'center', padding: '8px 0 2px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
            <div className="wl-toggle on"><div className="wl-toggle-lever" /></div>
            <span className="wl-microlabel">RX</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
            <div className="wl-toggle on"><div className="wl-toggle-lever" /></div>
            <span className="wl-microlabel">TX</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
            <div className="wl-toggle"><div className="wl-toggle-lever" /></div>
            <span className="wl-microlabel">SQL</span>
          </div>
        </div>
      </div>

      {/* ---- transceiver ---- */}
      <div className="wl-equip wl-rust-tr" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
        <span className="wl-screw wl-screw--tl" />
        <span className="wl-screw wl-screw--tr" />

        {/* header strip */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px' }}>
          <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: 2, color: '#dfd8c6' }}>
            {chat ? `✥ ${agentName} · DIRECT LINK` : '✥ NEW CHANNEL · SELECT FREQUENCY'}
          </span>
          {chat && (
            <span className="wl-mono" style={{ fontSize: 9, color: '#8fa0b0' }}>~${(chat.total_cost_usd ?? 0).toFixed(3)}</span>
          )}
          {chat && isLive && (
            <button
              className="wl-mono"
              style={{
                background: 'none', border: '1px solid rgba(178,86,68,.6)', borderRadius: 2, cursor: 'pointer',
                color: '#dd8471', fontSize: 9, letterSpacing: 1, padding: '2px 7px',
              }}
              onClick={() => post(`/api/tasks/${id}/cancel`).catch(() => {})}
            >
              END SESSION
            </button>
          )}
          <span
            className={`wl-led ${chat ? (isLive ? 'wl-led--green wl-led--blink' : 'wl-led--off') : 'wl-led--yellow wl-led--blink'}`}
            style={{ marginLeft: 'auto' }}
          />
          <span className="wl-microlabel">{chat ? (isLive ? 'CARRIER LOCKED' : 'CARRIER LOST') : 'STANDBY'}</span>
        </div>

        {id ? (
          /* CRT message log */
          <div className="wl-monitor-bezel" style={{ flex: 1, minHeight: 280, display: 'flex' }}>
            <div className="wl-crt" style={{ flex: 1, minWidth: 0, padding: '14px 16px 16px', display: 'flex', flexDirection: 'column', fontSize: 11.5 }}>
              <div className="wl-scanlines" />
              <div className="wl-glare" />
              <div className="wl-scanbar" />
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', position: 'relative', padding: '2px 6px 4px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, justifyContent: 'flex-end', minHeight: '100%' }}>
                  {log.length === 0 && !thinking && (
                    <div style={{ color: PHOS_DIM }}>AWAITING TRANSMISSION…</div>
                  )}
                  {log}
                  {chat && !isLive && (
                    <div style={{ color: '#dd8471', textShadow: '0 0 6px rgba(221,132,113,.35)' }}>
                      ✕ CARRIER LOST — {(chat.error || 'session ended').toUpperCase()}
                      <br />
                      <span style={{ color: PHOS_DIM }}>
                        TRANSMIT BELOW TO RE-OPEN THIS CHANNEL
                        {chat.integration_key ? '' : ' — SESSION MEMORY CARRIES OVER'}, OR START FRESH VIA + NEW.
                      </span>
                    </div>
                  )}
                  {streamText ? (
                    <div>
                      <span className="wl-crt-text">{agentName}&gt;</span>{' '}
                      <span style={{ color: TIME_GREEN }}>▓ streaming</span>
                      <br />
                      <span className="wl-crt-text" style={{ whiteSpace: 'pre-wrap' }}>{streamText}<span className="wl-cursor" /></span>
                    </div>
                  ) : thinking ? (
                    <div className="wl-crt-text">
                      {agentName}&gt; PROCESSING<span className="wl-cursor" />
                    </div>
                  ) : null}
                  <div ref={bottomRef} />
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* agent picker — first transmission opens the channel */
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, padding: '0 4px' }}>
            <div className="wl-mono" style={{ fontSize: 10, color: '#8fa0b0', padding: '2px 2px 4px' }}>
              Pick who answers. The session stays alive between messages — your agent can read files, search,
              and (with your approval) act. First transmission opens the channel.
            </div>
            {agents.map((a) => (
              <div
                key={a.id}
                className="wl-tile"
                onClick={() => setAgentId(a.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', cursor: 'pointer',
                  ...(agentId === a.id
                    ? { border: '1px solid var(--wl-yellow)', boxShadow: '0 0 0 1px rgba(232,193,74,.3), 0 2px 4px rgba(0,0,0,.35)' }
                    : {}),
                }}
              >
                <span
                  style={{
                    width: 34, height: 34, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'radial-gradient(ellipse at 50% 40%, #232c35, #10151a)', border: '1px solid var(--wl-line)',
                    fontSize: 16, color: 'var(--wl-phos-g)', textShadow: '0 0 8px var(--wl-phos-g-glow)',
                  }}
                >
                  {a.icon}
                </span>
                <span style={{ minWidth: 0 }}>
                  <span className="wl-mono" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, letterSpacing: 1, color: 'var(--wl-cream)' }}>
                    {a.name}
                    {a.integration_key && (
                      <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: 1, color: '#34e2ff', border: '1px solid rgba(52,226,255,.5)', borderRadius: 2, padding: '0 4px' }}>
                        ⇄ REMOTE
                      </span>
                    )}
                  </span>
                  <span className="wl-mono" style={{ display: 'block', fontSize: 9.5, color: '#8fa0b0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {a.role || 'generalist'}
                  </span>
                </span>
                <span
                  className={`wl-led ${agentId === a.id ? 'wl-led--green' : 'wl-led--off'}`}
                  style={{ marginLeft: 'auto', flexShrink: 0 }}
                />
              </div>
            ))}
          </div>
        )}

        {/* transmit row */}
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="wl-input"
            style={{ flex: 1 }}
            placeholder={chat && !isLive ? `carrier lost — transmit to re-open channel with ${agentName.toLowerCase()}` : `transmit to ${agentName.toLowerCase()}…`}
            disabled={inputDisabled}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                send()
              }
            }}
          />
          <div className="wl-btn-housing">
            <button
              className="wl-btn"
              disabled={!draft.trim() || inputDisabled}
              style={!draft.trim() || inputDisabled ? { opacity: 0.5, cursor: 'default' } : undefined}
              onClick={send}
            >
              SEND ▸
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function renderLog(events: TaskEvent[], agentName: string) {
  const out: React.ReactNode[] = []
  for (const e of events) {
    const key = `${e.task_id}-${e.seq}`
    if (e.type === 'user_message') {
      out.push(
        <div key={key}>
          <span style={{ color: OPERATOR_AMBER, textShadow: '0 0 5px rgba(194,161,63,.4)' }}>OVERSEER&gt;</span>{' '}
          <span style={{ color: TIME_GREEN }}>{fmtTime(e.ts)}</span>
          <br />
          <span style={{ color: OPERATOR_AMBER, whiteSpace: 'pre-wrap' }}>{e.payload.text}</span>
        </div>,
      )
    } else if (e.type === 'assistant_text') {
      out.push(
        <div key={key}>
          <span className="wl-crt-text">{agentName}&gt;</span>{' '}
          <span style={{ color: TIME_GREEN }}>{fmtTime(e.ts)}</span>
          <br />
          <span className="wl-crt-text" style={{ whiteSpace: 'pre-wrap' }}>{e.payload.text}</span>
        </div>,
      )
    } else if (e.type === 'tool_use') {
      out.push(
        <div key={key} style={{ color: PHOS_DIM, fontSize: 10.5 }}>
          ▸ {e.payload.tool}{' '}
          {String(e.payload.input?.command ?? e.payload.input?.file_path ?? e.payload.input?.pattern ?? '').slice(0, 90)}
        </div>,
      )
    } else if (e.type === 'memory_write') {
      const saved: string[] = (e.payload.remember ?? []).map((r: any) => r.content)
      const dropped: string[] = e.payload.forget ?? []
      out.push(
        <div key={key} style={{ color: 'var(--wl-yellow)', fontSize: 10.5, textShadow: '0 0 6px rgba(232,193,74,.35)' }}>
          {saved.map((c, i) => <div key={`r${i}`}>◈ MEMORY COMMITTED — {c}</div>)}
          {dropped.map((c, i) => <div key={`f${i}`}>◈ MEMORY DROPPED — {c}</div>)}
        </div>,
      )
    } else if (e.type === 'approval_requested') {
      out.push(
        <Link
          key={key}
          to="/approvals"
          style={{
            display: 'block', textDecoration: 'none', color: 'var(--wl-yellow)',
            textShadow: '0 0 6px rgba(232,193,74,.5)', animation: 'wl-blink 2.4s infinite',
          }}
        >
          ⏸ APPROVAL REQUIRED — {e.payload.tool} — TAP TO REVIEW
        </Link>,
      )
    }
  }
  return out
}
