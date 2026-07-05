import { useEffect } from 'react'
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { get, getToken } from './lib/api'
import { wsClient } from './lib/ws'
import { useStore } from './store'
import Approvals from './views/Approvals'
import Chat from './views/Chat'
import Login from './views/Login'
import Memory from './views/Memory'
import MissionControl from './views/MissionControl'
import Orchestrator from './views/Orchestrator'
import Scheduler from './views/Scheduler'
import Skills from './views/Skills'
import TaskBoard from './views/TaskBoard'
import TaskDetail from './views/TaskDetail'

const NAV_SECTIONS: { title: string; items: { to: string; label: string; icon: string }[] }[] = [
  {
    title: 'Operations',
    items: [
      { to: '/', label: 'Mission Control', icon: '◉' },
      { to: '/board', label: 'Task Board', icon: '▦' },
      { to: '/chat', label: 'Comms / Chat', icon: '⌁' },
    ],
  },
  {
    title: 'Orchestration',
    items: [
      { to: '/orchestrator', label: 'Pipelines', icon: '⧉' },
      { to: '/scheduler', label: 'Scheduler', icon: '↻' },
    ],
  },
  {
    title: 'Intelligence',
    items: [
      { to: '/memory', label: 'Memory Core', icon: '◈' },
      { to: '/skills', label: 'Pantheon', icon: 'Ω' },
    ],
  },
  {
    title: 'Control',
    items: [{ to: '/approvals', label: 'Approvals', icon: '✋' }],
  },
]

function Clock() {
  const now = new Date()
  return (
    <span className="font-mono text-[10px] tracking-widest text-ink-dim">
      {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
    </span>
  )
}

function Shell() {
  const wsStatus = useStore((s) => s.wsStatus)
  const pendingCount = useStore((s) => s.pendingApprovalCount)
  const approvalBump = useStore((s) => s.approvalBump)
  const location = useLocation()

  useEffect(() => {
    wsClient.connect()
    wsClient.subscribe('global')
    get<unknown[]>('/api/approvals?status=pending')
      .then((list) => useStore.getState().setPendingApprovalCount(list.length))
      .catch(() => {})
  }, [])

  if (!getToken()) return <Navigate to="/login" replace />

  return (
    <div className="flex h-screen flex-col md:flex-row">
      <div className="os-backdrop" />

      {/* sidebar (desktop) / bottom bar (mobile) */}
      <nav className="glass order-last z-10 flex shrink-0 !rounded-none border-t border-edge md:order-first md:w-56 md:flex-col md:border-r md:border-t-0">
        <div className="hidden px-4 py-5 md:block">
          <div className="neon-text font-mono text-xl font-bold tracking-[0.25em] text-accent">
            AGENT<span className="text-ink">OS</span>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                wsStatus === 'open' ? 'bg-ok' : wsStatus === 'connecting' ? 'bg-warn dot-running' : 'bg-err'
              }`}
            />
            <span className="hud-label !text-[9px]">
              {wsStatus === 'open' ? 'uplink · online' : `uplink · ${wsStatus}`}
            </span>
            <span className="ml-auto"><Clock /></span>
          </div>
          <hr className="neon-divider mt-3" />
        </div>

        <div className="flex flex-1 justify-around overflow-y-auto md:flex-col md:justify-start md:gap-0.5 md:px-2 md:pb-3">
          {NAV_SECTIONS.map((section) => (
            <div key={section.title} className="contents md:block">
              <div className="hud-label mt-4 hidden px-3 pb-1 md:block">{section.title}</div>
              {section.items.map((item) => {
                const active = item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to)
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={`relative flex items-center gap-2.5 px-3 py-2.5 text-[13px] transition-colors md:rounded-md ${
                      active
                        ? 'bg-accent/10 text-accent shadow-[inset_2px_0_0_0_#7fc8ff] md:shadow-[inset_2px_0_0_0_#7fc8ff]'
                        : 'text-ink-dim hover:bg-panel-2/60 hover:text-ink'
                    }`}
                  >
                    <span className={active ? 'neon-text' : ''}>{item.icon}</span>
                    <span className="hidden md:inline">{item.label}</span>
                    {item.to === '/approvals' && pendingCount > 0 && (
                      <span
                        key={approvalBump}
                        className="badge-pop absolute -top-0.5 right-1 rounded-full bg-warn px-1.5 font-mono text-[10px] font-bold text-black md:static md:ml-auto"
                      >
                        {pendingCount}
                      </span>
                    )}
                  </Link>
                )
              })}
            </div>
          ))}
        </div>

        <div className="hidden px-4 pb-4 md:block">
          <hr className="neon-divider mb-2" />
          <div className="hud-label !text-[9px] !tracking-[0.15em]">operator · spezzuti</div>
        </div>
      </nav>

      <main className="scanlines relative min-h-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
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
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
