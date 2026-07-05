import { useEffect, useState } from 'react'
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { get, getToken } from './lib/api'
import { wsClient } from './lib/ws'
import { useStore } from './store'
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

// Each section carries its own accent via CSS vars — themes swap the values.
const NAV_SECTIONS: { title: string; items: { to: string; label: string; icon: string; color: string }[] }[] = [
  {
    title: 'Operations',
    items: [
      { to: '/', label: 'Overseer Console', icon: '◉', color: 'var(--sec-console)' },
      { to: '/board', label: 'Task Board', icon: '▦', color: 'var(--sec-board)' },
      { to: '/chat', label: 'Comms / Chat', icon: '⌁', color: 'var(--sec-comms)' },
    ],
  },
  {
    title: 'Orchestration',
    items: [
      { to: '/orchestrator', label: 'Pipelines', icon: '⧉', color: 'var(--sec-pipes)' },
      { to: '/scheduler', label: 'Scheduler', icon: '↻', color: 'var(--sec-sched)' },
    ],
  },
  {
    title: 'Intelligence',
    items: [
      { to: '/memory', label: 'Holotapes', icon: '◈', color: 'var(--sec-memory)' },
      { to: '/skills', label: 'Companions', icon: 'Ω', color: 'var(--sec-companions)' },
      { to: '/dreaming', label: 'Simulations', icon: '☾', color: 'var(--sec-dreams)' },
    ],
  },
  {
    title: 'Control',
    items: [
      { to: '/approvals', label: 'Vault Door', icon: '⚿', color: 'var(--sec-vault)' },
      { to: '/system', label: 'System · Setup', icon: '⚙', color: 'var(--sec-system)' },
    ],
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

const THEMES = [
  { key: '', label: 'WASTELAND' },
  { key: 'cyber', label: 'CYBER' },
]
const SKINS = [
  { key: '', label: 'CRT·OFF' },
  { key: 'crt-green', label: 'GRN' },
  { key: 'crt-amber', label: 'AMBR' },
]

function applyAttr(attr: 'skin' | 'theme', key: string) {
  if (key) document.documentElement.dataset[attr] = key
  else delete document.documentElement.dataset[attr]
  localStorage.setItem(`agentos_${attr}`, key)
}

export function initSkin() {
  for (const attr of ['skin', 'theme'] as const) {
    const saved = localStorage.getItem(`agentos_${attr}`) ?? ''
    if (saved) document.documentElement.dataset[attr] = saved
  }
}

function ToggleRow({ options, attr }: { options: { key: string; label: string }[]; attr: 'skin' | 'theme' }) {
  const [value, setValue] = useState(localStorage.getItem(`agentos_${attr}`) ?? '')
  return (
    <div className="flex gap-1">
      {options.map((o) => (
        <button
          key={o.key}
          className={`flex-1 rounded border px-1 py-0.5 font-mono text-[9px] font-bold tracking-widest ${
            value === o.key ? 'border-accent/60 bg-accent/15 text-accent' : 'border-edge text-ink-dimmer hover:text-ink-dim'
          }`}
          onClick={() => {
            applyAttr(attr, o.key)
            setValue(o.key)
            if (attr === 'theme') window.dispatchEvent(new Event('agentos:theme'))
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function useIsCyber(): boolean {
  const [cyber, setCyber] = useState(document.documentElement.dataset.theme === 'cyber')
  useEffect(() => {
    const handler = () => setCyber(document.documentElement.dataset.theme === 'cyber')
    window.addEventListener('agentos:theme', handler)
    return () => window.removeEventListener('agentos:theme', handler)
  }, [])
  return cyber
}

function SkinToggle() {
  return (
    <div className="space-y-1">
      <ToggleRow options={THEMES} attr="theme" />
      <ToggleRow options={SKINS} attr="skin" />
    </div>
  )
}

function Shell() {
  const wsStatus = useStore((s) => s.wsStatus)
  const pendingCount = useStore((s) => s.pendingApprovalCount)
  const approvalBump = useStore((s) => s.approvalBump)
  const location = useLocation()
  const cyber = useIsCyber()

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
            {cyber ? (
              <>THE <span className="text-ink">GIBSON</span></>
            ) : (
              <>PIP-<span className="text-ink">OS</span><span className="align-super text-[9px] text-ink-dim">®</span></>
            )}
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
                      active ? '' : 'text-ink-dim hover:bg-panel-2/60 hover:text-ink'
                    }`}
                    style={active ? {
                      color: item.color,
                      background: `color-mix(in srgb, ${item.color} 9%, transparent)`,
                      boxShadow: `inset 2px 0 0 0 ${item.color}`,
                    } : undefined}
                  >
                    <span style={{ color: item.color, textShadow: active ? `0 0 12px ${item.color}` : undefined, opacity: active ? 1 : 0.75 }}>
                      {item.icon}
                    </span>
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
          <div className="hud-label !text-[9px] !tracking-[0.15em]">{cyber ? 'zero cool · spezzuti' : 'overseer · spezzuti'}</div>
          <div className="mt-2">
            <SkinToggle />
          </div>
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
          <Route path="/dreaming" element={<Dreaming />} />
          <Route path="/system" element={<System />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
