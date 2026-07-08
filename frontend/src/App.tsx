import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { get, getToken } from './lib/api'
import { getCrtSkin, setCrtSkin } from './lib/theme'
import { wsClient } from './lib/ws'
import { setBadge, primeAudio } from './lib/notify'
import { primeSound, sfx } from './lib/sound'
import { useIsMobile } from './lib/mobile'
import { useStore } from './store'
import { ACTIVE_STATUSES } from './lib/types'
import NewTaskModal from './components/NewTaskModal'
import WastelandBoot from './components/WastelandBoot'
import CyberShell from './components/CyberShell'
import Approvals from './views/Approvals'
import Chat from './views/Chat'
import Dreaming from './views/Dreaming'
import Login from './views/Login'
import Memory from './views/Memory'
import MissionControl from './views/MissionControl'
import Orchestrator from './views/Orchestrator'
import Scheduler from './views/Scheduler'
import Skills from './views/Skills'
import System from './views/System'
import TaskBoard from './views/TaskBoard'
import TaskDetail from './views/TaskDetail'

const NAV_GROUPS: { label: string; items: { to: string; label: string; icon: string }[] }[] = [
  {
    label: 'Operations',
    items: [
      { to: '/', label: 'Overseer Console', icon: '◉' },
      { to: '/board', label: 'Task Board', icon: '▦' },
      { to: '/chat', label: 'Comms', icon: '⌁' },
    ],
  },
  {
    label: 'Orchestration',
    items: [
      { to: '/orchestrator', label: 'Pipelines', icon: '⧉' },
      { to: '/scheduler', label: 'Scheduler', icon: '↻' },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { to: '/memory', label: 'Holotapes', icon: '◈' },
      { to: '/skills', label: 'Companions', icon: 'Ω' },
      { to: '/dreaming', label: 'Simulations', icon: '☾' },
    ],
  },
  {
    label: 'Control',
    items: [
      { to: '/approvals', label: 'Vault Door', icon: '⚿' },
      { to: '/system', label: 'System', icon: '⚙' },
    ],
  },
]

const SCREEN_TITLES: [string, string][] = [
  ['/board', 'TASK BOARD'],
  ['/chat', 'COMMS'],
  ['/orchestrator', 'PIPELINES'],
  ['/scheduler', 'SCHEDULER'],
  ['/memory', 'HOLOTAPES'],
  ['/skills', 'COMPANIONS'],
  ['/dreaming', 'SIMULATIONS'],
  ['/approvals', 'VAULT DOOR'],
  ['/system', 'SYSTEM'],
  ['/tasks', 'EXECUTION LOG'],
]

// The mode knob switches THEME only — each theme owns its own login + boot, and
// the knob (plus GRID//OS's "quit to pip-os") are the only ways to swap.
const MODES = [
  { label: 'WASTELAND', theme: '', deg: -30 },
  { label: 'CYBER', theme: 'cyber', deg: 30 },
]

function applyMode(index: number) {
  const mode = MODES[index]
  if (mode.theme) document.documentElement.dataset.theme = mode.theme
  else delete document.documentElement.dataset.theme
  localStorage.setItem('agentos_theme', mode.theme)
  localStorage.setItem('agentos_mode', String(index))
}

export function initSkin() {
  const savedMode = Number(localStorage.getItem('agentos_mode') ?? '0')
  if (savedMode > 0 && savedMode < MODES.length) applyMode(savedMode)
  setCrtSkin(getCrtSkin())
}

function Clock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000)
    return () => clearInterval(t)
  }, [])
  return <>{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</>
}

function Shell() {
  const wsStatus = useStore((s) => s.wsStatus)
  const pendingCount = useStore((s) => s.pendingApprovalCount)
  const tasks = useStore((s) => s.tasks)
  const location = useLocation()
  const navigate = useNavigate()
  const initMode = Number(localStorage.getItem('agentos_mode') ?? '0') % MODES.length
  const [mode, setMode] = useState(initMode)
  const [showDeploy, setShowDeploy] = useState(false)
  const mobile = useIsMobile()
  const [navOpen, setNavOpen] = useState(false)
  // PIP-OS entry ceremony. A fresh authed load/refresh replays just the ROBCO
  // boot; switching in from cyber runs the full login → boot sequence.
  const [entry, setEntry] = useState<'login' | 'boot' | 'ready'>(
    () => (getToken() && MODES[initMode].theme !== 'cyber' ? 'boot' : 'ready'),
  )

  useEffect(() => {
    wsClient.connect()
    wsClient.subscribe('global')
    get<unknown[]>('/api/approvals?status=pending')
      .then((list) => useStore.getState().setPendingApprovalCount(list.length))
      .catch(() => {})
  }, [])

  // keep the tab title + favicon badge in sync with pending approvals
  useEffect(() => { setBadge(pendingCount) }, [pendingCount])

  // browsers block audio until a user gesture — prime the notify chime + UI sfx on first interaction
  useEffect(() => {
    const prime = () => { primeAudio(); primeSound() }
    window.addEventListener('pointerdown', prime, { once: true })
    window.addEventListener('keydown', prime, { once: true })
    return () => {
      window.removeEventListener('pointerdown', prime)
      window.removeEventListener('keydown', prime)
    }
  }, [])

  // One delegated listener gives every physical control in every view its sound —
  // capture phase so stopPropagation in a view can't silence the console.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.(
        '.wl-knob, .wl-nav-item, button, [role="button"], select, input[type="checkbox"], input[type="radio"]',
      ) as HTMLElement | null
      if (!el || (el as HTMLButtonElement).disabled) return
      if (el.classList.contains('wl-knob')) sfx.knob()
      else if (el.classList.contains('wl-nav-item')) sfx.nav()
      else sfx.click()
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [])

  if (!getToken()) return <Navigate to="/login" replace />

  // CYBER position on the knob = GRID//OS: a full-screen cyberpunk desktop takeover.
  // Quitting back to PIP-OS runs the full login → boot ceremony below.
  if (MODES[mode].theme === 'cyber') {
    return <CyberShell onExit={() => { applyMode(0); setMode(0); setEntry('login') }} />
  }

  // PIP-OS re-entry: ceremonial login (already authed → no token re-entry) → boot → console.
  if (entry === 'login') return <Login onProceed={() => setEntry('boot')} />

  const screenTitle = SCREEN_TITLES.find(([p]) => location.pathname.startsWith(p) && p !== '/')?.[1]
    ?? 'OVERSEER CONSOLE'
  const liveBurn = Object.values(tasks)
    .filter((t) => ACTIVE_STATUSES.includes(t.status))
    .reduce((sum, t) => sum + (t.total_cost_usd ?? 0), 0)
  // gauge sweep: $0 → -82°, $1+ → +82°
  const needleDeg = Math.min(82, -82 + Math.min(liveBurn, 1) * 164)

  function cycleMode() {
    const next = (mode + 1) % MODES.length
    applyMode(next)
    setMode(next)
    // From PIP-OS the knob only advances to CYBER, which hands off to GRID//OS
    // and runs its own boot. (Returning to PIP-OS happens via quit-to-pip.)
  }

  return (
    <div className="wl-app" style={{ display: 'grid', gridTemplateColumns: mobile ? '1fr' : '232px 1fr', height: '100vh', overflow: 'hidden', animation: 'wl-flicker 9s infinite' }}>
      {entry === 'boot' && <WastelandBoot onDone={() => setEntry('ready')} />}
      {mobile && navOpen && (
        <div
          onClick={() => setNavOpen(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 65, background: 'rgba(4,7,10,.6)', backdropFilter: 'blur(1px)' }}
        />
      )}
      {/* ============ SIDEBAR ============ */}
      <div
        className="wl-rust-bl"
        style={{
          borderRight: '3px solid #10151a', display: 'flex', flexDirection: 'column', overflow: 'hidden',
          // phone: the rack becomes a slide-out drawer under the ☰ latch
          ...(mobile
            ? {
                position: 'fixed', top: 0, bottom: 0, left: 0, width: 'min(78vw, 290px)', zIndex: 70,
                transform: navOpen ? 'translateX(0)' : 'translateX(-105%)',
                transition: 'transform .22s ease-out',
                background: 'linear-gradient(180deg, #39424c, #262f39)',
                boxShadow: navOpen ? '12px 0 44px rgba(0,0,0,.55)' : 'none',
              }
            : { position: 'relative' }),
        }}
      >
        <div className="wl-chevron" />
        <span className="wl-screw" style={{ top: 20, left: 7 }} />
        <span className="wl-screw wl-screw--rusty" style={{ top: 20, right: 9 }} />
        <div className="wl-drip" style={{ top: 29, right: 9, height: 68 }} />

        <div
          style={{ padding: '18px 16px 10px', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
          title="reboot terminal"
          onClick={() => setEntry('boot')}
        >
          <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'radial-gradient(circle at 35% 30%,#4a5a6a,#212a33)', border: '2px solid #d9ad2e', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#e8c14a', fontWeight: 700, fontSize: 13, boxShadow: '0 2px 4px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.15)' }}>76</div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#dfd8c6', letterSpacing: 2, textShadow: '0 1px 0 rgba(255,255,255,.1),0 -1px 1px rgba(0,0,0,.6)' }}>PIP-OS</div>
            <div style={{ fontSize: 8, color: '#8fa0b0', letterSpacing: 2 }}>VAULT-TEC CERTIFIED</div>
          </div>
        </div>

        {/* uplink CRT strip */}
        <div style={{ margin: '4px 12px', background: 'linear-gradient(180deg,#141a20,#1c242c)', border: '1px solid #10151a', borderRadius: 8, padding: 5, boxShadow: 'inset 0 2px 5px rgba(0,0,0,.7),0 1px 0 rgba(255,255,255,.06)' }}>
          <div className="wl-crt wl-crt--flat" style={{ padding: '8px 10px' }}>
            <div className="wl-scanlines" />
            <div className="wl-glare" style={{ width: '50%', height: '34%', top: '8%', left: '6%' }} />
            <div style={{ fontSize: 10.5 }} className="wl-crt-text">
              &gt; UPLINK {wsStatus === 'open' ? 'ONLINE' : wsStatus.toUpperCase()}
              <span className="wl-cursor" style={{ width: 6, height: 10 }} />
            </div>
            <div style={{ fontSize: 9, marginTop: 2 }}><Clock /> · SECTOR LOCAL</div>
          </div>
        </div>

        {/* nav */}
        <div style={{ padding: '12px 14px 0', display: 'flex', flexDirection: 'column', gap: 15, overflowY: 'auto' }}>
          {NAV_GROUPS.map((group) => (
            <div key={group.label} style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <div className="wl-nav-label">{group.label}</div>
              {group.items.map((item) => {
                const active = item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to)
                return (
                  <div key={item.to} className={`wl-nav-item${active ? ' active' : ''}`} onClick={() => { navigate(item.to); setNavOpen(false) }}>
                    <span style={{ width: 14, textAlign: 'center' }}>{item.icon}</span>
                    {item.label}
                    {item.to === '/approvals' && pendingCount > 0 && (
                      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5 }}>
                        <span className="wl-led wl-led--yellow wl-led--blink" />
                        <span className="wl-mono" style={{ fontSize: 10 }}>{pendingCount}</span>
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        {/* sticky note */}
        <div style={{ marginTop: 'auto', padding: '16px 14px 20px' }}>
          <div className="wl-sticky">
            <div className="wl-sticky-paper">
              check burn gauge<br />before deploy!!<br />
              <span style={{ display: 'block', textAlign: 'right', marginRight: 16 }}>— overseer</span>
            </div>
            <div className="wl-sticky-curl-shadow" />
            <div className="wl-sticky-curl" />
            <div className="wl-tape wl-tape--tl" />
            <div className="wl-tape wl-tape--tr" />
          </div>
        </div>
      </div>

      {/* ============ MAIN ============ */}
      <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: mobile ? 10 : 14, padding: mobile ? '12px 12px 4px' : '18px 20px 4px' }}>
          {mobile && (
            <button
              type="button"
              className="wl-btn wl-btn--steel"
              title="open the rack"
              style={{ padding: '8px 11px', fontSize: 14, lineHeight: 1, flex: 'none' }}
              onClick={() => setNavOpen(true)}
            >
              ☰
            </button>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <div className="wl-nameplate" style={mobile ? { maxWidth: '100%', overflow: 'hidden' } : undefined}>
              <span className="wl-screw" />
              <span className="wl-screw wl-screw--rusty" />
              <div className="wl-engraved" style={{ fontSize: mobile ? 13 : 17, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{screenTitle}</div>
            </div>
            {!mobile && (
              <div className="wl-mono" style={{ fontSize: 10, color: '#8fa0b0', letterSpacing: 1, paddingLeft: 2 }}>
                {/* personalize via localStorage.setItem('agentos_operator', 'YOUR NAME') */}
                {new Date().toUTCString().slice(0, 16).toUpperCase()} · OVERSEER: {(localStorage.getItem('agentos_operator') || 'ON DUTY').toUpperCase()}
              </div>
            )}
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: mobile ? 10 : 16, flex: 'none' }}>
            {!mobile && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                <div className="wl-gauge">
                  <div className="wl-gauge-face" />
                  <div className="wl-gauge-arc" />
                  <div className="wl-needle" style={{ transform: `rotate(${needleDeg}deg)` }} />
                  <div className="wl-gauge-hub" />
                </div>
                <span className="wl-microlabel">LIVE BURN · ${liveBurn.toFixed(2)}</span>
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
              <div className="wl-knob" onClick={cycleMode} title="switch theme">
                <div className="wl-knob-cap">
                  <span className="wl-knob-mark" style={{ transform: `translateX(-50%) rotate(${MODES[mode].deg}deg)` }} />
                </div>
              </div>
              <span className="wl-microlabel">{MODES[mode].label}</span>
            </div>
            <div className="wl-btn-housing">
              <button className="wl-btn" style={mobile ? { padding: '8px 10px', fontSize: 10 } : undefined} onClick={() => setShowDeploy(true)}>
                {mobile ? '+ DEPLOY' : '+ DEPLOY AGENT'}
              </button>
            </div>
          </div>
        </div>

        <main style={{ flex: 1, overflowY: 'auto', padding: mobile ? '10px 10px 16px' : '14px 20px 20px' }}>
          <Outlet />
        </main>
      </div>

      {showDeploy && <NewTaskModal onClose={() => setShowDeploy(false)} />}
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<Shell />}>
          <Route path="/" element={<MissionControl />} />
          <Route path="/board" element={<TaskBoard />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/chat/:id" element={<Chat />} />
          <Route path="/orchestrator" element={<Orchestrator />} />
          <Route path="/tasks/:id" element={<TaskDetail />} />
          <Route path="/approvals" element={<Approvals />} />
          <Route path="/memory" element={<Memory />} />
          <Route path="/skills" element={<Skills />} />
          <Route path="/scheduler" element={<Scheduler />} />
          <Route path="/dreaming" element={<Dreaming />} />
          <Route path="/system" element={<System />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
