import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import { get, getToken } from './lib/api'
import { getActiveConnection, isAuthFailed, subscribe as subscribeConnections } from './lib/connections'
import { getCrtSkin, setCrtSkin } from './lib/theme'
import { wsClient } from './lib/ws'
import { setBadge, primeAudio } from './lib/notify'
import { consumePendingNav } from './lib/nativeBridge'
import { primeSound, sfx } from './lib/sound'
import { useIsMobile } from './lib/mobile'
import { useStore } from './store'
import { ACTIVE_STATUSES } from './lib/types'
import NewTaskModal from './components/NewTaskModal'
import WastelandBoot from './components/WastelandBoot'
import CommsFeed from './components/CommsFeed'
import ApprovalToast from './components/ApprovalToast'
import MasterOnlyToast from './components/MasterOnlyToast'
import CyberShell from './components/CyberShell'
import Approvals from './views/Approvals'
import Chat from './views/Chat'
import Devices from './views/Devices'
import Dreaming from './views/Dreaming'
import Knowledge from './views/Knowledge'
import Login from './views/Login'
import PairDevice from './views/PairDevice'
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
      { to: '/knowledge', label: 'Knowledge', icon: '❋' },
      { to: '/skills', label: 'Companions', icon: 'Ω' },
      { to: '/dreaming', label: 'Simulations', icon: '☾' },
    ],
  },
  {
    label: 'Control',
    items: [
      { to: '/approvals', label: 'Vault Door', icon: '⚿' },
      { to: '/devices', label: 'Handsets', icon: '☏' },
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
  ['/knowledge', 'KNOWLEDGE ARCHIVE'],
  ['/skills', 'COMPANIONS'],
  ['/dreaming', 'SIMULATIONS'],
  ['/approvals', 'VAULT DOOR'],
  ['/devices', 'HANDSETS'],
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
  const updateAvailable = useStore((s) => s.updateAvailable)
  const updateLatest = useStore((s) => s.updateLatest)
  const setUpdateStatus = useStore((s) => s.setUpdateStatus)
  const pushTicker = useStore((s) => s.pushTicker)
  const location = useLocation()
  const navigate = useNavigate()
  // Under Capacitor the phone is pinned to PIP-OS: GRID//OS is a desktop-only
  // takeover, so mode is forced to 0 and the theme knob is hidden below.
  const native = Capacitor.isNativePlatform()
  const initMode = native ? 0 : Number(localStorage.getItem('agentos_mode') ?? '0') % MODES.length
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
    // Who am I — master console or paired handset? Locks master-only controls
    // honestly on devices. Failure leaves identity null (treated as master UI,
    // where any stray 403 still surfaces via the MasterOnlyToast backstop).
    get<{ kind: 'master' | 'device'; scopes: string[] | null }>('/api/whoami')
      .then((who) => useStore.getState().setIdentity(who))
      .catch(() => {})
  }, [])

  // keep the tab title + favicon badge in sync with pending approvals
  useEffect(() => { setBadge(pendingCount) }, [pendingCount])

  // Native deep-link: tapping the FCM notification BODY launches the app with a
  // nav target that MainActivity stashes in native storage. Consume it on mount and
  // whenever the app returns to the foreground, then route (defaults to /approvals).
  useEffect(() => {
    if (!native) return
    let cancelled = false
    const check = async () => {
      const target = await consumePendingNav()
      if (target && !cancelled) navigate(target)
    }
    void check()
    const onVis = () => { if (document.visibilityState === 'visible') void check() }
    document.addEventListener('visibilitychange', onVis)
    return () => { cancelled = true; document.removeEventListener('visibilitychange', onVis) }
  }, [native, navigate])

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

  // Proactive self-update surfacing (PIP-OS). Once the wasteland console is READY,
  // pull /api/update/status ONCE (plus a slow re-check) so the COMMS strip announces
  // and the System nav badge lights up from ANY page — not just when the user happens
  // to open Settings ▸ System. GRID//OS's CyberShell runs its own equivalent check,
  // so this stays out of cyber mode; it also never runs during the login/boot ceremony.
  useEffect(() => {
    if (MODES[mode].theme === 'cyber' || entry !== 'ready') return
    let stop = false
    const check = async () => {
      try {
        const u = await get<{ update_available?: boolean; latest?: string }>('/api/update/status')
        if (stop) return
        const avail = !!u.update_available && !!u.latest
        setUpdateStatus(avail, u.latest ?? '')
        // One COMMS push per newly-seen version — shared localStorage guard with the
        // System panel keeps the announce from double-firing across the two fetchers.
        if (avail && localStorage.getItem('agentos_update_announced') !== u.latest) {
          localStorage.setItem('agentos_update_announced', u.latest as string)
          pushTicker({ ts: new Date().toISOString(), tone: 'info',
            text: `◤ UPDATE AVAILABLE — Rezident v${u.latest} · System page to install` })
        }
      } catch { /* status never hard-fails server-side; ignore transport errors */ }
    }
    check()
    const t = setInterval(check, 6 * 60 * 60 * 1000) // slow re-check; the on-ready fetch is the core fix
    return () => { stop = true; clearInterval(t) }
  }, [mode, entry, setUpdateStatus, pushTicker])

  // Web auth gate (unchanged): no token → /login. The native no-connection case is
  // handled ABOVE Shell by RootGate, so Shell (and its data-loading effects, which
  // would 401→/login on the phone) never mounts until a connection exists.
  if (!native && !getToken()) return <Navigate to="/login" replace />

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
    if (native) return // PIP-OS is pinned on the phone; the knob is hidden anyway.
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
              {wsStatus !== 'open' ? (
                <>&gt; UPLINK {wsStatus.toUpperCase()}</>
              ) : updateAvailable ? (
                <span
                  className="wl-pulse-amber"
                  style={{ color: 'var(--wl-yellow)', textShadow: '0 0 6px rgba(232,193,74,.5)', cursor: 'pointer' }}
                  title="update available — open System"
                  onClick={() => { navigate('/system'); setNavOpen(false) }}
                >
                  &gt; ▲ UPDATE AVAILABLE{updateLatest ? ` — v${updateLatest}` : ''}
                </span>
              ) : (
                <>&gt; UPLINK ONLINE</>
              )}
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
              {group.items.filter((item) => !(native && item.to === '/devices')).map((item) => {
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
                    {item.to === '/system' && updateAvailable && (
                      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5 }} title="update available">
                        <span className="wl-led wl-led--yellow wl-led--blink" />
                        <span className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-yellow)' }}>UPD</span>
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
            {!native && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                <div className="wl-knob" onClick={cycleMode} title="switch theme">
                  <div className="wl-knob-cap">
                    <span className="wl-knob-mark" style={{ transform: `translateX(-50%) rotate(${MODES[mode].deg}deg)` }} />
                  </div>
                </div>
                <span className="wl-microlabel">{MODES[mode].label}</span>
              </div>
            )}
            <div className="wl-btn-housing">
              <button className="wl-btn" style={mobile ? { padding: '8px 10px', fontSize: 10 } : undefined} onClick={() => setShowDeploy(true)}>
                {mobile ? '+ DEPLOY' : '+ DEPLOY AGENT'}
              </button>
            </div>
          </div>
        </div>

        <main style={{ flex: 1, overflowY: 'auto', padding: mobile ? '10px 10px 44px' : '14px 20px 46px' }}>
          <Outlet />
        </main>
      </div>

      {/* live COMMS FEED — renders store.ticker at the bottom of every PIP page.
          Only once the console is showing (not during login/boot ceremony). */}
      {entry === 'ready' && <CommsFeed mobile={mobile} />}

      {/* sticky top-right approval interrupt — same ready-only gate as COMMS FEED */}
      {entry === 'ready' && <ApprovalToast mobile={mobile} />}
      {entry === 'ready' && <MasterOnlyToast mobile={mobile} />}

      {showDeploy && <NewTaskModal onClose={() => setShowDeploy(false)} />}
    </div>
  )
}

// Top-level gate for the Capacitor app. The phone has no /login: with no active
// connection (fresh install) or after a device token is invalidated mid-session
// (`agentos:auth-failed` → reportAuthFailure → notify), render the in-app pairing
// screen INSTEAD of Shell — so Shell's data effects never fire a 401 that would
// bounce the WebView to /login. On the web this is a transparent pass-through to
// Shell (native is false), so nothing regresses. Re-renders on connection changes.
function RootGate() {
  const [, tick] = useState(0)
  useEffect(() => subscribeConnections(() => tick((n) => n + 1)), [])
  const native = Capacitor.isNativePlatform()
  if (native && (!getActiveConnection() || isAuthFailed())) {
    return <PairDevice onPaired={() => tick((n) => n + 1)} />
  }
  return <Shell />
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<RootGate />}>
          <Route path="/" element={<MissionControl />} />
          <Route path="/board" element={<TaskBoard />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/chat/:id" element={<Chat />} />
          <Route path="/orchestrator" element={<Orchestrator />} />
          <Route path="/tasks/:id" element={<TaskDetail />} />
          <Route path="/approvals" element={<Approvals />} />
          <Route path="/devices" element={<Devices />} />
          <Route path="/memory" element={<Memory />} />
          <Route path="/knowledge" element={<Knowledge />} />
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
