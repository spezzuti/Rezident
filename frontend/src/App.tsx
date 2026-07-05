import { useEffect } from 'react'
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { get, getToken } from './lib/api'
import { wsClient } from './lib/ws'
import { useStore } from './store'
import Approvals from './views/Approvals'
import Login from './views/Login'
import Memory from './views/Memory'
import Scheduler from './views/Scheduler'
import Skills from './views/Skills'
import MissionControl from './views/MissionControl'
import TaskBoard from './views/TaskBoard'
import TaskDetail from './views/TaskDetail'

const NAV = [
  { to: '/', label: 'Mission Control', icon: '◉' },
  { to: '/board', label: 'Task Board', icon: '▦' },
  { to: '/approvals', label: 'Approvals', icon: '✋' },
  { to: '/memory', label: 'Memory', icon: '◈' },
  { to: '/skills', label: 'Skills & Tools', icon: '⬡' },
  { to: '/scheduler', label: 'Scheduler', icon: '↻' },
]

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
    <div className="flex h-screen flex-col bg-bg md:flex-row">
      {/* sidebar (desktop) / bottom bar (mobile) */}
      <nav className="order-last flex shrink-0 border-t border-edge bg-panel md:order-first md:w-52 md:flex-col md:border-r md:border-t-0">
        <div className="hidden px-4 py-4 md:block">
          <div className="font-mono text-lg font-bold tracking-widest text-accent">
            AGENT<span className="text-ink">OS</span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-ink-dim">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                wsStatus === 'open' ? 'bg-ok' : wsStatus === 'connecting' ? 'bg-warn dot-running' : 'bg-err'
              }`}
            />
            {wsStatus === 'open' ? 'link established' : wsStatus}
          </div>
        </div>
        <div className="flex flex-1 justify-around md:flex-col md:justify-start md:gap-1 md:px-2">
          {NAV.map((item) => {
            const active = item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to)
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`relative flex items-center gap-2 px-3 py-2.5 text-sm md:rounded-md ${
                  active ? 'text-accent md:bg-accent/10' : 'text-ink-dim hover:text-ink'
                }`}
              >
                <span>{item.icon}</span>
                <span className="hidden md:inline">{item.label}</span>
                {item.to === '/approvals' && pendingCount > 0 && (
                  <span
                    key={approvalBump}
                    className="badge-pop absolute -top-0.5 right-1 rounded-full bg-warn px-1.5 text-[10px] font-bold text-black md:static md:ml-auto"
                  >
                    {pendingCount}
                  </span>
                )}
              </Link>
            )
          })}
        </div>
      </nav>
      <main className="min-h-0 flex-1 overflow-y-auto">
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
