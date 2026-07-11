import { useEffect, useRef, useState } from 'react'
import { useIsMobile } from '../lib/mobile'
import { useNavigate } from 'react-router-dom'
import { get, post } from '../lib/api'
import { sfx } from '../lib/sound'
import type { Task, TaskStatus } from '../lib/types'
import { useStore } from '../store'

const ACTIVE_SET = ['queued', 'running', 'awaiting_approval', 'waiting_input', 'verifying']

/** The single touch action a card supports, mirroring the drag rules:
 *  active card → cancel (the drag-to-Failed gesture); terminal card → retry
 *  (the drag-to-Queued gesture). */
function cardAction(t: Task): 'cancel' | 'retry' {
  return ACTIVE_SET.includes(t.status) ? 'cancel' : 'retry'
}

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

/** Nearest scrollable ancestor — the board's scroll container (the app <main>),
 *  used for edge auto-scroll while a touch-drag is in flight. */
function scrollParent(el: HTMLElement | null): HTMLElement {
  let n: HTMLElement | null = el ? el.parentElement : null
  while (n) {
    const s = getComputedStyle(n)
    if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight) return n
    n = n.parentElement
  }
  return (document.scrollingElement as HTMLElement) || document.documentElement
}

/** Column key under a viewport point, via the lanes' data-col markers.
 *  The drag ghost sets pointer-events:none so it is never the hit. */
function colAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null
  const lane = el ? (el.closest('[data-col]') as HTMLElement | null) : null
  return lane ? lane.getAttribute('data-col') : null
}

/** Mutable per-gesture state for the mobile touch-drag. Kept in a ref so the
 *  document listeners (added once per pickup) always see live values without
 *  re-binding on every re-render. */
type TouchSess = {
  task: Task | null
  active: boolean
  startX: number
  startY: number
  lastX: number
  lastY: number
  offX: number
  offY: number
  width: number
  height: number
  timer: number | null
  raf: number | null
  scroller: HTMLElement | null
  move: ((e: TouchEvent) => void) | null
  end: (() => void) | null
}

export default function TaskBoard() {
  const mobile = useIsMobile()
  const tasks = useStore((s) => s.tasks)
  const setTasks = useStore((s) => s.setTasks)
  const upsertTask = useStore((s) => s.upsertTask)
  const [dragTask, setDragTask] = useState<Task | null>(null)
  const [overCol, setOverCol] = useState<string | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  // Mobile touch-drag: the picked-up card + the floating ghost's finger point.
  const [touchDrag, setTouchDrag] = useState<Task | null>(null)
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const sess = useRef<TouchSess>({
    task: null, active: false, startX: 0, startY: 0, lastX: 0, lastY: 0,
    offX: 0, offY: 0, width: 0, height: 0, timer: null, raf: null,
    scroller: null, move: null, end: null,
  })
  const navigate = useNavigate()
  // Whichever drag is live (desktop HTML5 or mobile touch) drives lane highlights.
  const activeDrag = dragTask ?? touchDrag

  useEffect(() => {
    get<Task[]>('/api/tasks').then(setTasks)
  }, [setTasks])

  // Close the tap-menu on any outside interaction. The kebab/menu buttons
  // stopPropagation, so this only fires for taps elsewhere.
  useEffect(() => {
    if (!menuFor) return
    const close = () => setMenuFor(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menuFor])

  const all = Object.values(tasks)
    .filter((t) => t.kind !== 'chat')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))

  async function cancelTask(t: Task) {
    await post(`/api/tasks/${t.id}/cancel`).catch(() => {})
  }
  async function retryTask(t: Task) {
    const child = await post<Task>(`/api/tasks/${t.id}/retry`).catch(() => null)
    if (child) {
      upsertTask(child)
      navigate(`/tasks/${child.id}`)
    }
  }

  // The one place the (task, column) → action rules run. Both the desktop
  // HTML5 drop and the mobile touch drop funnel through here so they stay
  // byte-for-byte identical.
  async function performDrop(t: Task, columnKey: string) {
    const action = dropAction(t, columnKey)
    if (action === 'cancel') await cancelTask(t)
    else if (action === 'retry') await retryTask(t)
  }

  async function handleDrop(columnKey: string) {
    if (!dragTask) return
    const t = dragTask
    setOverCol(null)
    setDragTask(null)
    await performDrop(t, columnKey)
  }

  // ---- mobile touch drag-and-drop -----------------------------------------
  // Tear down a gesture: kill timers/raf, detach the document listeners bound
  // at pickup, and clear the ghost. Safe to call for a plain tap too.
  function endTouchDrag() {
    const s = sess.current
    if (s.timer) { clearTimeout(s.timer); s.timer = null }
    if (s.raf) { cancelAnimationFrame(s.raf); s.raf = null }
    if (s.move) document.removeEventListener('touchmove', s.move)
    if (s.end) {
      document.removeEventListener('touchend', s.end)
      document.removeEventListener('touchcancel', s.end)
    }
    s.active = false
    s.task = null
    s.scroller = null
    s.move = null
    s.end = null
    setTouchDrag(null)
    setGhost(null)
    setOverCol(null)
  }

  // Long-press fired without an early scroll — lift the card into a drag.
  function beginTouchDrag() {
    const s = sess.current
    if (!s.task) return
    s.active = true
    s.timer = null
    s.scroller = scrollParent(rootRef.current)
    try { navigator.vibrate && navigator.vibrate(14) } catch { /* no haptics */ }
    sfx.click()
    setTouchDrag(s.task)
    setGhost({ x: s.lastX, y: s.lastY })

    // Non-passive move listener so preventDefault actually blocks page scroll
    // (React binds onTouchMove passively, so it can't). Also drives the ghost
    // + lane targeting.
    const move = (e: TouchEvent) => {
      if (!s.active) return
      e.preventDefault()
      const p = e.touches[0]
      if (!p) return
      s.lastX = p.clientX
      s.lastY = p.clientY
      setGhost({ x: p.clientX, y: p.clientY })
      setOverCol(colAt(p.clientX, p.clientY))
    }
    const end = () => {
      const t = s.task
      const key = colAt(s.lastX, s.lastY)
      const action = t && key ? dropAction(t, key) : null
      endTouchDrag()
      if (t && action) {
        if (action === 'cancel') sfx.deny(); else sfx.confirm()
        void performDrop(t, key as string)
      }
    }
    s.move = move
    s.end = end
    document.addEventListener('touchmove', move, { passive: false })
    document.addEventListener('touchend', end)
    document.addEventListener('touchcancel', end)

    // Edge auto-scroll: lanes stack far apart on mobile, so near the top/bottom
    // of the scroll container we nudge it and re-resolve the lane under the
    // (stationary) finger as content slides past.
    const EDGE = 72
    const step = () => {
      if (!s.active) { s.raf = null; return }
      const sc = s.scroller
      if (sc) {
        const r = sc.getBoundingClientRect()
        let dv = 0
        if (s.lastY < r.top + EDGE) dv = -Math.min(16, Math.ceil((r.top + EDGE - s.lastY) / 5))
        else if (s.lastY > r.bottom - EDGE) dv = Math.min(16, Math.ceil((s.lastY - (r.bottom - EDGE)) / 5))
        if (dv !== 0) {
          const max = sc.scrollHeight - sc.clientHeight
          const next = Math.max(0, Math.min(max, sc.scrollTop + dv))
          if (next !== sc.scrollTop) {
            sc.scrollTop = next
            setOverCol(colAt(s.lastX, s.lastY))
          }
        }
      }
      s.raf = requestAnimationFrame(step)
    }
    s.raf = requestAnimationFrame(step)
  }

  function onCardTouchStart(e: React.TouchEvent, t: Task) {
    if (!mobile) return
    // Don't hijack the kebab button / its menu — those stay taps.
    if ((e.target as HTMLElement).closest('button')) return
    const p = e.touches[0]
    if (!p) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const s = sess.current
    if (s.timer) clearTimeout(s.timer)
    s.task = t
    s.active = false
    s.startX = p.clientX
    s.startY = p.clientY
    s.lastX = p.clientX
    s.lastY = p.clientY
    s.offX = p.clientX - rect.left
    s.offY = p.clientY - rect.top
    s.width = rect.width
    s.height = rect.height
    s.timer = window.setTimeout(beginTouchDrag, 360)
  }

  function onCardTouchMove(e: React.TouchEvent) {
    const s = sess.current
    if (s.active || !s.task) return // active drag is driven by the doc listener
    const p = e.touches[0]
    if (!p) return
    // Moved before the long-press landed → it's a scroll, not a pickup.
    if (Math.abs(p.clientX - s.startX) > 10 || Math.abs(p.clientY - s.startY) > 10) {
      if (s.timer) { clearTimeout(s.timer); s.timer = null }
      s.task = null
    }
  }

  function onCardTouchEnd() {
    const s = sess.current
    if (s.active) return // drop handled by the document listener
    // A tap (or an aborted scroll): cancel the pending pickup, let onClick run.
    if (s.timer) { clearTimeout(s.timer); s.timer = null }
    s.task = null
  }

  useEffect(() => endTouchDrag, []) // safety net: detach listeners on unmount

  return (
    <div ref={rootRef} style={{ minHeight: '100%', padding: '16px 20px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
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
              gridTemplateColumns: mobile ? 'minmax(0,1fr)' : 'repeat(5,minmax(0,1fr))',
              gap: 16,
              alignItems: 'start',
            }}
          >
            {COLUMNS.map((col, i) => {
              const items = all.filter((t) => col.statuses.includes(t.status))
              const legal = activeDrag ? dropAction(activeDrag, col.key) : null
              const isOver = overCol === col.key && !!legal
              return (
                <div
                  key={col.key}
                  data-col={col.key}
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
                  {items.map((t) => {
                    const action = cardAction(t)
                    return (
                    <div
                      key={t.id}
                      draggable={!mobile}
                      onDragStart={() => setDragTask(t)}
                      onDragEnd={() => {
                        setDragTask(null)
                        setOverCol(null)
                      }}
                      onTouchStart={(e) => onCardTouchStart(e, t)}
                      onTouchMove={onCardTouchMove}
                      onTouchEnd={onCardTouchEnd}
                      onClick={() => navigate(`/tasks/${t.id}`)}
                      style={{
                        transform: `rotate(${cardRot(t.id)}deg)`,
                        position: 'relative',
                        backgroundImage:
                          'radial-gradient(ellipse 40px 26px at 100% 100%,rgba(120,100,60,.16),transparent 70%),linear-gradient(170deg,#f2ead0,#e6d9b4)',
                        padding: mobile ? '14px 48px 10px 11px' : '15px 11px 10px',
                        boxShadow: '0 3px 7px rgba(0,0,0,.38),0 1px 2px rgba(0,0,0,.25)',
                        cursor: mobile ? 'pointer' : 'grab',
                        opacity: activeDrag?.id === t.id ? (mobile ? 0.4 : 0.55) : 1,
                      }}
                    >
                      {/* touch tap-menu — HTML5 drag never fires on touch, so
                          phones drive cancel/retry through this kebab instead */}
                      {mobile && (
                        <button
                          type="button"
                          aria-label="Task actions"
                          onClick={(e) => {
                            e.stopPropagation()
                            sfx.click()
                            setMenuFor((m) => (m === t.id ? null : t.id))
                          }}
                          style={{
                            position: 'absolute',
                            top: 5,
                            right: 5,
                            width: 38,
                            height: 30,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            padding: 0,
                            border: '1px solid rgba(60,40,20,.45)',
                            borderRadius: 3,
                            background: 'linear-gradient(180deg,rgba(255,250,236,.9),rgba(226,214,184,.9))',
                            color: '#5a4a2c',
                            fontSize: 19,
                            lineHeight: 1,
                            fontWeight: 700,
                            cursor: 'pointer',
                            boxShadow: '0 1px 2px rgba(0,0,0,.28)',
                            touchAction: 'manipulation',
                          }}
                        >
                          ⋯
                        </button>
                      )}
                      {mobile && menuFor === t.id && (
                        <div
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            position: 'absolute',
                            top: 34,
                            right: 5,
                            zIndex: 30,
                            minWidth: 138,
                            padding: 5,
                            background: 'linear-gradient(170deg,#f6efd9,#e6d9b6)',
                            border: '1px solid rgba(60,40,20,.55)',
                            borderRadius: 3,
                            boxShadow: '0 7px 16px rgba(0,0,0,.5),0 2px 4px rgba(0,0,0,.35)',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 4,
                          }}
                        >
                          <button
                            type="button"
                            className="wl-mono"
                            onClick={(e) => {
                              e.stopPropagation()
                              setMenuFor(null)
                              if (action === 'cancel') {
                                sfx.deny()
                                cancelTask(t)
                              } else {
                                sfx.confirm()
                                retryTask(t)
                              }
                            }}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              width: '100%',
                              minHeight: 42,
                              padding: '9px 11px',
                              border: '1px solid rgba(60,40,20,.3)',
                              borderRadius: 2,
                              background: 'rgba(255,255,255,.35)',
                              color: action === 'cancel' ? '#b23a2a' : '#3f7d3a',
                              fontSize: 11,
                              fontWeight: 700,
                              letterSpacing: 2,
                              textTransform: 'uppercase',
                              cursor: 'pointer',
                              textAlign: 'left',
                            }}
                          >
                            <span style={{ fontSize: 14 }}>{action === 'cancel' ? '⊘' : '↻'}</span>
                            {action === 'cancel' ? 'Abort' : 'Re-run'}
                          </button>
                        </div>
                      )}
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
                    )
                  })}

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

      {/* action hint — drag on desktop, tap-menu on touch */}
      <div className="wl-mono" style={{ fontSize: 9.5, letterSpacing: 1, color: '#8fa0b0', textAlign: 'center' }}>
        {mobile ? (
          <>tap <span style={{ color: '#dfd8c6' }}>⋯</span> on a card to <span style={{ color: '#dd8471' }}>abort</span> or{' '}
          <span style={{ color: '#74dd8f' }}>re-run</span></>
        ) : (
          <>drag an active card to <span style={{ color: '#dd8471' }}>FAILED</span> to abort · drag a finished card to{' '}
          <span style={{ color: '#dfd8c6' }}>QUEUED</span> to re-run</>
        )}
      </div>

      {/* floating drag ghost — tracks the finger during a mobile touch-drag.
          pointer-events:none so elementFromPoint reads the lane beneath it. */}
      {touchDrag && ghost && (
        <div
          style={{
            position: 'fixed',
            left: ghost.x - sess.current.offX,
            top: ghost.y - sess.current.offY,
            width: sess.current.width,
            pointerEvents: 'none',
            zIndex: 1000,
            transform: 'rotate(2.5deg) scale(1.06)',
            transformOrigin: 'center',
            opacity: 0.96,
          }}
        >
          <div
            style={{
              position: 'relative',
              backgroundImage:
                'radial-gradient(ellipse 40px 26px at 100% 100%,rgba(120,100,60,.16),transparent 70%),linear-gradient(170deg,#f7f0d8,#ebdfba)',
              padding: '14px 12px 10px',
              boxShadow: '0 14px 26px rgba(0,0,0,.5),0 4px 8px rgba(0,0,0,.4)',
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: -5,
                left: '50%',
                marginLeft: -5,
                width: 11,
                height: 11,
                borderRadius: '50%',
                background: `radial-gradient(circle at 35% 30%, rgba(255,255,255,.55), ${pinColor(touchDrag)} 60%)`,
                backgroundColor: pinColor(touchDrag),
                boxShadow: '0 3px 4px rgba(0,0,0,.45),inset 0 1px 1px rgba(255,255,255,.45)',
              }}
            />
            <div className="wl-mono" style={{ fontSize: 11.5, color: '#3a3426', wordBreak: 'break-word' }}>
              {touchDrag.title}
            </div>
            <div
              className="wl-mono"
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 9.5, color: '#8a7a58', marginTop: 6, minWidth: 0 }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {touchDrag.agent_icon ? `${touchDrag.agent_icon} ` : ''}
                {touchDrag.agent_name ?? touchDrag.kind}
              </span>
              <span style={{ marginLeft: 'auto', flexShrink: 0 }}>~${touchDrag.total_cost_usd.toFixed(2)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
