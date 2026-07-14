import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { get, post } from '../lib/api'
import type { Task, TaskEvent } from '../lib/types'
import { ACTIVE_STATUSES } from '../lib/types'
import { useStore } from '../store'
import { wsClient } from '../lib/ws'
import { useIsMobile } from '../lib/mobile'
import { RobotIcon, robotKindFor } from '../components/RobotIcon'

const NO_EVENTS: TaskEvent[] = [] // stable ref — an inline `?? []` makes zustand's snapshot unstable and crashes the view

/* unified roster entry (/api/agents): local Claude personas + bridged runtimes */
interface ChatAgent {
  id: string
  name: string
  icon: string
  color: string
  role: string
  kind: string
  runtime?: string
  model?: string
  profile_id: string | null
  integration_key: string | null
  available: boolean
}

/* one seat parsed off a kind='roundtable' task's persisted config blob */
interface RTParticipant {
  name: string
  color: string
  profile_id?: string | null
  integration_key?: string | null
  model?: string | null
}

const OPERATOR_AMBER = '#c2a13f'
const PHOS_DIM = '#57a273'
const TIME_GREEN = '#3f8f5e'
const RED = '#dd8471'
const CONSENSUS_TOKEN = '[CONSENSUS]' // mirrors roundtable.CONSENSUS_TOKEN — a turn ending in it proposes agreement

const fmtTime = (ts: string) =>
  new Date(ts.endsWith('Z') ? ts : ts + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/* hex → rgba for a matching per-speaker text glow (roster colors are 6-digit hex) */
function glow(hex: string, a = 0.45): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex || '').trim())
  if (!m) return `rgba(125,232,154,${a})`
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

/* the roundtable roster + round count ride as a JSON blob on the task row */
function parseRoundtable(task?: Task): { participants: RTParticipant[]; rounds: number } | null {
  if (!task || task.kind !== 'roundtable' || !task.roundtable) return null
  try {
    const d = typeof task.roundtable === 'string' ? JSON.parse(task.roundtable) : (task.roundtable as any)
    const participants: RTParticipant[] = Array.isArray(d?.participants) ? d.participants : []
    return { participants, rounds: Number(d?.rounds) || 3 }
  } catch {
    return null
  }
}

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
  const [mode, setMode] = useState<'direct' | 'group'>('direct') // new-channel: single DM vs a roundtable
  const [groupPicks, setGroupPicks] = useState<string[]>([]) // seated agent ids for a group channel
  const [rounds, setRounds] = useState(3)
  const bottomRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const mobile = useIsMobile()

  const chat = id ? tasks[id] : undefined
  const chats = Object.values(tasks)
    .filter((t) => t.kind === 'chat' || t.kind === 'roundtable')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  const isLive = chat && ACTIVE_STATUSES.includes(chat.status)
  const thinking = chat?.status === 'running'
  const isRoundtable = chat?.kind === 'roundtable'
  const rt = useMemo(() => parseRoundtable(chat), [chat])
  const parked = isRoundtable && chat?.status === 'waiting_input' // parked between round-batches, awaiting the moderator

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

  function toggleGroupPick(aid: string) {
    setGroupPicks((cur) => (cur.includes(aid) ? cur.filter((x) => x !== aid) : [...cur, aid]))
  }

  async function send() {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    try {
      if (!id && mode === 'group') {
        // convene a roundtable: 2+ seats, the draft is the opening topic
        const picks = groupPicks.map((pid) => agents.find((a) => a.id === pid)).filter(Boolean) as ChatAgent[]
        if (picks.length < 2) {
          alert('seat at least 2 agents for a roundtable')
          return
        }
        const participants = picks.map((a) => ({
          profile_id: a.profile_id ?? null,
          integration_key: a.integration_key ?? null,
          name: a.name,
          color: a.color,
          model: a.model || null,
        }))
        const seats = picks.map((p) => p.name).join(' · ')
        const task = await post<Task>('/api/tasks', {
          title: `⧉ ${seats} — ${text.slice(0, 40)}`.slice(0, 200),
          prompt: text,
          kind: 'roundtable',
          roundtable: { participants, rounds },
        })
        upsertTask(task)
        navigate(`/chat/${task.id}`)
      } else if (!id) {
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
      } else if (chat && !isLive && !isRoundtable) {
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
        // live channel (DM or roundtable) — drop a moderator/operator message in
        await post(`/api/tasks/${id}/message`, { text })
      }
      setDraft('')
    } catch (e: any) {
      alert(e.message ?? 'send failed')
    } finally {
      setSending(false)
    }
  }

  // "▸ CONTINUE" — nudge a parked roundtable to run another batch of rounds
  async function continueSession() {
    if (!id || sending) return
    setSending(true)
    try {
      await post(`/api/tasks/${id}/message`, { text: 'Continue.' })
    } catch (e: any) {
      alert(e.message ?? 'continue failed')
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
  const log = useMemo(() => renderLog(events, agentName, !!isRoundtable), [events, agentName, isRoundtable])
  const roundtableClosed = !!isRoundtable && !isLive // a done/cancelled roundtable can't take more messages
  const inputDisabled = sending || roundtableClosed
  const groupReady = mode === 'group' ? groupPicks.length >= 2 : true

  const placeholder = !id
    ? mode === 'group'
      ? 'set the topic for the roundtable…'
      : `transmit to ${agentName.toLowerCase()}…`
    : isRoundtable
      ? roundtableClosed
        ? 'session adjourned'
        : parked
          ? 'interject as moderator — or press ▸ CONTINUE'
          : 'queue a note for the table…'
      : chat && !isLive
        ? `carrier lost — transmit to re-open channel with ${agentName.toLowerCase()}`
        : `transmit to ${agentName.toLowerCase()}…`

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
              {c.kind === 'roundtable' && (
                <span className="wl-mono" style={{ flexShrink: 0, fontSize: 8, letterSpacing: 1, color: 'var(--wl-yellow)', border: '1px solid rgba(232,193,74,.5)', borderRadius: 2, padding: '0 3px' }}>
                  ⧉
                </span>
              )}
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
            {chat
              ? isRoundtable
                ? `⧉ ROUNDTABLE · ${rt?.participants.length ?? 0} SEATED · ${rt?.rounds ?? 0}R`
                : `✥ ${agentName} · DIRECT LINK`
              : '✥ NEW CHANNEL · SELECT FREQUENCY'}
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
          <span className="wl-microlabel">
            {chat
              ? isRoundtable
                ? isLive
                  ? parked
                    ? 'AWAITING YOU'
                    : 'IN SESSION'
                  : 'ADJOURNED'
                : isLive
                  ? 'CARRIER LOCKED'
                  : 'CARRIER LOST'
              : 'STANDBY'}
          </span>
        </div>

        {/* participant chips — who's seated at this table */}
        {isRoundtable && rt && rt.participants.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '0 4px' }}>
            <span className="wl-microlabel" style={{ marginRight: 2 }}>SEATED</span>
            {rt.participants.map((p, i) => (
              <span
                key={i}
                className="wl-mono"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 9, letterSpacing: 1,
                  padding: '2px 7px', borderRadius: 2, color: p.color,
                  border: `1px solid ${p.color}`, background: 'rgba(0,0,0,.28)',
                  textShadow: `0 0 6px ${glow(p.color, 0.4)}`,
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: p.color, boxShadow: `0 0 5px ${glow(p.color, 0.8)}` }} />
                {p.name.toUpperCase()}
                {p.integration_key && <span style={{ opacity: 0.7 }}>◇</span>}
              </span>
            ))}
          </div>
        )}

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
                  {chat && !isLive && !isRoundtable && (
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
                  ) : thinking && isRoundtable ? (
                    <div style={{ color: PHOS_DIM }}>
                      ◌ ROUNDTABLE IN SESSION — agents composing<span className="wl-cursor" />
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
            {/* mode selector — a single DM or a group roundtable */}
            <div style={{ display: 'flex', gap: 6, padding: '2px 0 4px' }}>
              {(['direct', 'group'] as const).map((m) => (
                <button
                  key={m}
                  className="wl-mono"
                  onClick={() => setMode(m)}
                  style={{
                    flex: 1, cursor: 'pointer', fontSize: 10, letterSpacing: 1, padding: '6px 8px', borderRadius: 3,
                    background: mode === m ? 'linear-gradient(180deg, var(--wl-yellow-hi), var(--wl-yellow-lo))' : 'transparent',
                    color: mode === m ? '#20170a' : '#8fa0b0',
                    border: `1px solid ${mode === m ? 'var(--wl-yellow)' : 'var(--wl-line)'}`,
                    fontWeight: mode === m ? 700 : 400,
                  }}
                >
                  {m === 'direct' ? '✥ DIRECT LINK' : '⧉ ROUNDTABLE'}
                </button>
              ))}
            </div>
            <div className="wl-mono" style={{ fontSize: 10, color: '#8fa0b0', padding: '0 2px 4px' }}>
              {mode === 'group'
                ? 'Seat 2+ agents at one table. Each takes turns on a shared transcript; you moderate between round-batches. Your first transmission is the topic.'
                : 'Pick who answers. The session stays alive between messages — your agent can read files, search, and (with your approval) act. First transmission opens the channel.'}
            </div>
            {agents.map((a) => {
              const selected = mode === 'group' ? groupPicks.includes(a.id) : agentId === a.id
              const seat = mode === 'group' ? groupPicks.indexOf(a.id) : -1
              // same face everywhere: crew with a robot portrait wear it here too
              const robot = robotKindFor(a.name, a.profile_id ?? a.id)
              return (
                <div
                  key={a.id}
                  className="wl-tile"
                  onClick={() => (mode === 'group' ? toggleGroupPick(a.id) : setAgentId(a.id))}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', cursor: 'pointer',
                    ...(selected
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
                    {robot ? <RobotIcon kind={robot} size={26} /> : a.icon}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span className="wl-mono" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, letterSpacing: 1, color: 'var(--wl-cream)' }}>
                      {a.name}
                      {a.integration_key && (
                        <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: 1, color: '#34e2ff', border: '1px solid rgba(52,226,255,.5)', borderRadius: 2, padding: '0 4px' }}>
                          {a.runtime === 'remote' ? '⇄ REMOTE' : '▣ LOCAL'}
                        </span>
                      )}
                    </span>
                    <span className="wl-mono" style={{ display: 'block', fontSize: 9.5, color: '#8fa0b0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {a.role || 'generalist'}
                    </span>
                  </span>
                  {mode === 'group' && selected ? (
                    <span
                      className="wl-mono"
                      style={{
                        marginLeft: 'auto', flexShrink: 0, width: 18, height: 18, display: 'flex', alignItems: 'center',
                        justifyContent: 'center', fontSize: 10, fontWeight: 700, color: a.color, border: `1px solid ${a.color}`,
                        borderRadius: '50%', textShadow: `0 0 6px ${glow(a.color, 0.5)}`,
                      }}
                    >
                      {seat + 1}
                    </span>
                  ) : (
                    <span
                      className={`wl-led ${selected ? 'wl-led--green' : 'wl-led--off'}`}
                      style={{ marginLeft: 'auto', flexShrink: 0 }}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* rounds control — only while composing a new group channel */}
        {!id && mode === 'group' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 4px' }}>
            <span className="wl-microlabel">ROUNDS</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button
                className="wl-mono"
                onClick={() => setRounds((r) => Math.max(1, r - 1))}
                style={{ cursor: 'pointer', width: 22, height: 22, border: '1px solid var(--wl-line)', background: 'transparent', color: 'var(--wl-cream)', borderRadius: 3 }}
              >
                −
              </button>
              <span className="wl-mono" style={{ minWidth: 18, textAlign: 'center', fontSize: 13, fontWeight: 700, color: 'var(--wl-yellow)' }}>{rounds}</span>
              <button
                className="wl-mono"
                onClick={() => setRounds((r) => Math.min(20, r + 1))}
                style={{ cursor: 'pointer', width: 22, height: 22, border: '1px solid var(--wl-line)', background: 'transparent', color: 'var(--wl-cream)', borderRadius: 3 }}
              >
                +
              </button>
            </div>
            <span className="wl-mono" style={{ marginLeft: 'auto', fontSize: 9.5, color: groupReady ? PHOS_DIM : RED }}>
              {groupPicks.length} SEATED{groupReady ? '' : ' — NEED 2+'}
            </span>
          </div>
        )}

        {/* transmit row */}
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="wl-input"
            style={{ flex: 1 }}
            placeholder={placeholder}
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
          {parked && (
            <div className="wl-btn-housing">
              <button
                className="wl-btn"
                disabled={sending}
                style={sending ? { opacity: 0.5, cursor: 'default' } : undefined}
                onClick={continueSession}
                title="run another batch of rounds"
              >
                ▸ CONTINUE
              </button>
            </div>
          )}
          <div className="wl-btn-housing">
            <button
              className="wl-btn"
              disabled={!draft.trim() || inputDisabled || !groupReady}
              style={!draft.trim() || inputDisabled || !groupReady ? { opacity: 0.5, cursor: 'default' } : undefined}
              onClick={send}
            >
              {!id && mode === 'group' ? 'CONVENE ▸' : 'SEND ▸'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function renderLog(events: TaskEvent[], agentName: string, isRoundtable: boolean) {
  const out: React.ReactNode[] = []
  for (const e of events) {
    const key = `${e.task_id}-${e.seq}`
    if (e.type === 'user_message') {
      // moderator (roundtable) / overseer (DM) — always amber
      const who = (e.payload.agent_name || (isRoundtable ? 'MODERATOR' : 'OVERSEER')).toUpperCase()
      out.push(
        <div key={key}>
          <span style={{ color: OPERATOR_AMBER, textShadow: '0 0 5px rgba(194,161,63,.4)' }}>{who}&gt;</span>{' '}
          <span style={{ color: TIME_GREEN }}>{fmtTime(e.ts)}</span>
          <br />
          <span style={{ color: OPERATOR_AMBER, whiteSpace: 'pre-wrap' }}>{e.payload.text}</span>
        </div>,
      )
    } else if (e.type === 'assistant_text') {
      // attribution is PER MESSAGE in a roundtable — colour by the turn's own speaker
      const speaker = String(e.payload.agent_name || agentName).toUpperCase()
      const color = e.payload.agent_color as string | undefined
      const isErr = !!e.payload.error
      const raw = String(e.payload.text ?? '')
      const ci = raw.indexOf(CONSENSUS_TOKEN)
      const body = ci >= 0 ? raw.slice(0, ci).trim() : raw
      const conclusion = ci >= 0 ? raw.slice(ci + CONSENSUS_TOKEN.length).trim() : ''
      out.push(
        <div key={key}>
          <span
            className={color && !isErr ? undefined : 'wl-crt-text'}
            style={isErr ? { color: RED } : color ? { color, fontWeight: 700, textShadow: `0 0 6px ${glow(color, 0.5)}` } : undefined}
          >
            {speaker}&gt;
          </span>{' '}
          <span style={{ color: TIME_GREEN }}>{fmtTime(e.ts)}</span>
          <br />
          <span
            className={isErr ? undefined : 'wl-crt-text'}
            style={isErr ? { color: RED, whiteSpace: 'pre-wrap' } : { whiteSpace: 'pre-wrap' }}
          >
            {body}
          </span>
          {conclusion && (
            <div style={{ marginTop: 4, color: 'var(--wl-phos-g)', fontWeight: 700, textShadow: '0 0 8px var(--wl-phos-g-glow)' }}>
              ◆ {conclusion}
            </div>
          )}
        </div>,
      )
    } else if (e.type === 'roundtable') {
      // session-structure markers emitted by roundtable.py (payload.event = subtype)
      const sub = e.payload.event
      if (sub === 'round_start') {
        out.push(
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, color: PHOS_DIM, fontSize: 10, letterSpacing: 2, padding: '2px 0' }}>
            <span style={{ flex: 1, height: 1, background: 'rgba(87,162,115,.35)' }} />
            ROUND {e.payload.round} / {e.payload.of}
            <span style={{ flex: 1, height: 1, background: 'rgba(87,162,115,.35)' }} />
          </div>,
        )
      } else if (sub === 'session_start') {
        const n = Array.isArray(e.payload.participants) ? e.payload.participants.length : 0
        out.push(
          <div key={key} style={{ color: PHOS_DIM, fontSize: 10.5, letterSpacing: 1 }}>
            ◈ ROUNDTABLE CONVENED — {n} PARTICIPANTS · {e.payload.rounds} ROUNDS
          </div>,
        )
      } else if (sub === 'awaiting_moderator') {
        out.push(
          <div key={key} style={{ color: 'var(--wl-yellow)', fontSize: 11, letterSpacing: 1, textShadow: '0 0 6px rgba(232,193,74,.4)' }}>
            ⏸ AWAITING MODERATOR — interject below, or press ▸ CONTINUE
          </div>,
        )
      } else if (sub === 'consensus') {
        out.push(
          <div
            key={key}
            style={{
              margin: '4px 0', padding: '9px 10px', textAlign: 'center', letterSpacing: 3, fontWeight: 700, fontSize: 12,
              color: 'var(--wl-phos-g)', border: '1px solid var(--wl-phos-g)', background: 'rgba(116,221,143,.08)',
              textShadow: '0 0 10px var(--wl-phos-g-glow)', animation: 'wl-blink 2.4s infinite',
            }}
          >
            ◆◆ CONSENSUS REACHED ◆◆
          </div>,
        )
      } else if (sub === 'session_end') {
        out.push(
          <div key={key} style={{ color: PHOS_DIM, fontSize: 10.5, letterSpacing: 1 }}>
            ■ SESSION ADJOURNED
          </div>,
        )
      }
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
