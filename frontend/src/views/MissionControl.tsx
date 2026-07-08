import { useEffect } from 'react'
import { useIsMobile } from '../lib/mobile'
import { Link } from 'react-router-dom'
import { get } from '../lib/api'
import { ACTIVE_STATUSES, type Stats, type Task } from '../lib/types'
import { useStore } from '../store'

const BADGE_CLS: Record<string, string> = {
  done: 'wl-badge wl-badge--done',
  running: 'wl-badge wl-badge--running',
  failed: 'wl-badge wl-badge--failed',
  queued: 'wl-badge wl-badge--queued',
  cancelled: 'wl-badge wl-badge--cancelled',
}

function taskHref(t: Task): string {
  return t.kind === 'chat' ? `/chat/${t.id}` : `/tasks/${t.id}`
}

function taskIcon(t: Task): string {
  return t.agent_icon ?? (t.kind === 'chat' ? '⌁' : '◆')
}

function ActiveAgentsPanel({ active }: { active: Task[] }) {
  return (
    <div
      className="wl-equip wl-rust-bl"
      style={{ padding: '12px 12px 8px', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 276 }}
    >
      <span className="wl-screw wl-screw--tl" />
      <span className="wl-screw wl-screw--rusty wl-screw--tr" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px' }}>
        <span
          style={{
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: 2,
            color: '#dfd8c6',
            textShadow: '0 1px 0 rgba(255,255,255,.08),0 -1px 1px rgba(0,0,0,.5)',
          }}
        >
          ACTIVE AGENTS
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 7, letterSpacing: 1.5, color: '#8fa0b0' }}>VDU-3000</span>
      </div>
      <div className="wl-monitor-bezel" style={{ flex: 1 }}>
        <div
          className="wl-crt wl-power-on"
          style={{
            height: '100%',
            minHeight: 178,
            ...(active.length === 0
              ? { display: 'flex', alignItems: 'center', justifyContent: 'center' }
              : { padding: '12px 14px', overflowY: 'auto' }),
          }}
        >
          <div className="wl-scanlines" />
          <div className="wl-glare" />
          <div className="wl-glare wl-glare--low" />
          <div className="wl-scanbar" />
          {active.length === 0 ? (
            <div className="wl-crt-text" style={{ fontSize: 11 }}>
              — no live agents —<span className="wl-cursor" />
            </div>
          ) : (
            <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {active.map((t) => (
                <Link
                  key={t.id}
                  to={taskHref(t)}
                  className="wl-crt-text"
                  style={{
                    display: 'block',
                    fontSize: 11,
                    textDecoration: 'none',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                  title={t.title}
                >
                  ▸ {taskIcon(t)} {t.title} · {t.status.replace(/_/g, ' ')}
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '2px 8px' }}>
        <div
          style={{
            flex: 1,
            height: 7,
            background: 'repeating-linear-gradient(90deg,#141a20 0 5px,transparent 5px 9px)',
            borderRadius: 2,
            opacity: 0.7,
          }}
        />
        <div className="wl-knob" style={{ width: 15, height: 15 }}>
          <div className="wl-knob-cap" style={{ width: 9, height: 9 }}>
            <span className="wl-knob-mark" style={{ height: 4, width: 1.5, top: 0 }} />
          </div>
        </div>
        <div className="wl-knob" style={{ width: 15, height: 15 }}>
          <div className="wl-knob-cap" style={{ width: 9, height: 9 }}>
            <span
              className="wl-knob-mark"
              style={{
                height: 4,
                width: 1.5,
                top: 0,
                transform: 'translateX(-50%) rotate(50deg)',
                transformOrigin: '50% 4.5px',
              }}
            />
          </div>
        </div>
        <span className="wl-led wl-led--green" />
      </div>
    </div>
  )
}

function RadarPanel({ activeCount }: { activeCount: number }) {
  return (
    <div
      className="wl-equip wl-rust-tr"
      style={{
        padding: 10,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
      }}
    >
      <span className="wl-screw wl-screw--tl" />
      <span className="wl-screw wl-screw--rusty wl-screw--br" />
      <div
        style={{
          width: 208,
          height: 208,
          borderRadius: '50%',
          background: 'conic-gradient(from 40deg,#485866,#28323d 90deg,#485866 180deg,#232c35 270deg,#485866)',
          padding: 9,
          boxShadow:
            '0 8px 14px rgba(0,0,0,.5),0 2px 4px rgba(0,0,0,.45),inset 0 1px 1px rgba(255,255,255,.15),inset 0 -2px 3px rgba(0,0,0,.4),inset 0 0 12px rgba(109,179,217,.12)',
        }}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            borderRadius: '50%',
            background: 'radial-gradient(circle at 50% 42%,#17212a,#0e141a 75%)',
            boxShadow:
              'inset 0 4px 10px rgba(0,0,0,.8),inset 0 0 22px rgba(109,179,217,.06),0 0 18px rgba(109,179,217,.14)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <div style={{ position: 'absolute', inset: 24, borderRadius: '50%', border: '1px dashed #2b3742' }} />
          <div style={{ position: 'absolute', inset: 58, borderRadius: '50%', border: '1px solid #2b3742' }} />
          <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', height: 1, background: 'rgba(61,76,90,.55)' }} />
          <div style={{ position: 'absolute', top: 0, bottom: 0, left: '50%', width: 1, background: 'rgba(61,76,90,.55)' }} />
          <div
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: '50%',
              background:
                'conic-gradient(from 0deg,rgba(109,179,217,.42) 0deg,rgba(109,179,217,.13) 34deg,transparent 62deg)',
              animation: 'wl-sweep 6s linear infinite',
            }}
          />
          <div
            style={{
              position: 'absolute',
              left: '12%',
              top: '8%',
              width: '44%',
              height: '24%',
              background: 'radial-gradient(ellipse at center,rgba(255,255,255,.06),transparent 65%)',
              borderRadius: '50%',
              transform: 'rotate(-14deg)',
              pointerEvents: 'none',
            }}
          />
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: '50%',
              background: 'radial-gradient(circle at 35% 30%,#f2cd52,#b98a1e)',
              border: '2px solid #10151a',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 700,
              fontSize: 18,
              color: '#232a20',
              boxShadow: '0 2px 6px rgba(0,0,0,.5),0 0 16px rgba(232,193,74,.2)',
              position: 'relative',
              zIndex: 1,
            }}
          >
            {activeCount}
          </div>
        </div>
      </div>
      <div className="wl-lcd">
        {activeCount === 0 ? 'ALL AGENTS IDLE' : `${activeCount} AGENT${activeCount === 1 ? '' : 'S'} DEPLOYED`}
      </div>
    </div>
  )
}

function StatTileWl({
  label,
  value,
  accentCls,
  accentStyle,
  valStyle,
  ledCls,
}: {
  label: string
  value: string
  accentCls: string
  accentStyle?: React.CSSProperties
  valStyle: React.CSSProperties
  ledCls: string
}) {
  return (
    <div className="wl-tile" style={{ padding: '9px 12px', display: 'flex', alignItems: 'center', gap: 10, position: 'relative' }}>
      <span
        style={{
          position: 'absolute',
          right: -8,
          top: '50%',
          width: 8,
          height: 8,
          background: 'linear-gradient(180deg,#3a4450,#20282f)',
          transform: 'translateY(-50%)',
          borderRadius: 2,
          border: '1px solid #10151a',
        }}
      />
      <div className={accentCls} style={accentStyle} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 9, letterSpacing: 1.5, color: '#8fa0b0' }}>{label}</div>
        <div style={{ fontSize: 21 }}>
          <span style={valStyle}>{value}</span>
        </div>
      </div>
      <span className={ledCls} />
    </div>
  )
}

function CableBundle() {
  return (
    <svg
      viewBox="0 0 44 300"
      preserveAspectRatio="none"
      style={{ position: 'absolute', right: -20, top: 0, width: 44, height: '100%', overflow: 'visible' }}
    >
      <path d="M0 32 C14 44, 8 120, 13 190 C17 245, 24 272, 46 284" fill="none" stroke="#141a20" strokeWidth="4.6" strokeLinecap="round" />
      <path d="M0 32 C14 44, 8 120, 13 190 C17 245, 24 272, 46 284" fill="none" stroke="#c2a13f" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M0 104 C12 114, 5 170, 9 220 C13 262, 20 282, 46 292" fill="none" stroke="#141a20" strokeWidth="4.6" strokeLinecap="round" />
      <path d="M0 104 C12 114, 5 170, 9 220 C13 262, 20 282, 46 292" fill="none" stroke="#4a6a8a" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M0 176 C11 186, 6 218, 10 246 C14 274, 22 290, 46 299" fill="none" stroke="#141a20" strokeWidth="4.6" strokeLinecap="round" />
      <path d="M0 176 C11 186, 6 218, 10 246 C14 274, 22 290, 46 299" fill="none" stroke="#a34a3a" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M0 248 C6 254, 4 262, 6 272" fill="none" stroke="#141a20" strokeWidth="4" strokeLinecap="round" />
      <path d="M0 248 C6 254, 4 262, 6 272" fill="none" stroke="#4a6a8a" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M6 272 C4 278, 2 282, 3 288" fill="none" stroke="#3a5a78" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M6 272 C8 279, 9 283, 8 289" fill="none" stroke="#4a6a8a" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M6 272 C6 277, 5 281, 6 285" fill="none" stroke="#c98a4a" strokeWidth="1.1" strokeLinecap="round" />
      <rect x="8" y="228" width="10" height="14" rx="2" fill="#2c241a" stroke="#10151a" />
    </svg>
  )
}

export default function MissionControl() {
  const mobile = useIsMobile()
  const tasks = useStore((s) => s.tasks)
  const stats = useStore((s) => s.stats)
  const setTasks = useStore((s) => s.setTasks)
  const setStats = useStore((s) => s.setStats)

  useEffect(() => {
    get<Task[]>('/api/tasks').then(setTasks)
    get<Stats>('/api/stats').then(setStats)
    const t = setInterval(() => get<Stats>('/api/stats').then(setStats).catch(() => {}), 30000)
    return () => clearInterval(t)
  }, [setTasks, setStats])

  const all = Object.values(tasks)
  const active = all
    .filter((t) => ACTIVE_STATUSES.includes(t.status))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  const recent = all
    .filter((t) => !ACTIVE_STATUSES.includes(t.status))
    .sort((a, b) => (b.finished_at ?? b.created_at).localeCompare(a.finished_at ?? a.created_at))
    .slice(0, 9)
  const liveCost = active.reduce((sum, t) => sum + (t.total_cost_usd ?? 0), 0)
  const tokensToday = ((stats?.tokens_today.input ?? 0) + (stats?.tokens_today.output ?? 0)) / 1000

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: mobile ? 'minmax(0,1fr)' : 'minmax(0,1fr) minmax(0,1fr) 250px', gap: 12 }}>
        <ActiveAgentsPanel active={active} />

        <RadarPanel activeCount={active.length} />

        <div className="wl-mono" style={{ display: 'flex', flexDirection: 'column', gap: 8, position: 'relative', paddingRight: 24 }}>
          <CableBundle />
          <StatTileWl
            label="CAPS SPENT TODAY"
            value={`$${(stats?.cost_today_usd ?? 0).toFixed(3)}`}
            accentCls="wl-accent wl-accent--caution"
            valStyle={{ color: '#e8c14a', textShadow: '0 0 8px rgba(232,193,74,.25)' }}
            ledCls="wl-led wl-led--yellow"
          />
          <StatTileWl
            label="TOKENS TODAY"
            value={`${tokensToday.toFixed(1)}k`}
            accentCls="wl-accent"
            accentStyle={{ background: '#5f9cc4' }}
            valStyle={{ color: '#74dd8f' }}
            ledCls="wl-led wl-led--green"
          />
          <StatTileWl
            label="LIVE BURN"
            value={`$${liveCost.toFixed(3)}`}
            accentCls="wl-accent"
            accentStyle={{ background: '#b25644' }}
            valStyle={{ color: '#dd8471' }}
            ledCls={liveCost > 0 ? 'wl-led wl-led--red' : 'wl-led wl-led--off'}
          />
          <StatTileWl
            label="WEEK TOTAL"
            value={`$${(stats?.cost_week_usd ?? 0).toFixed(2)}`}
            accentCls="wl-accent"
            accentStyle={{ background: '#dfd8c6' }}
            valStyle={{ color: '#7fc3e8' }}
            ledCls="wl-led wl-led--blue"
          />
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="wl-sectionlabel">Recent Operations</span>
          <div className="wl-divider" style={{ flex: 1 }} />
        </div>
        <div className="wl-mono" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          {recent.map((t) => (
            <Link
              key={t.id}
              to={taskHref(t)}
              className="wl-tile"
              style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6, textDecoration: 'none' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#dfe6ec' }}>
                <span style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                  {taskIcon(t)} {t.title}
                </span>
                <span className={BADGE_CLS[t.status] ?? 'wl-badge wl-badge--queued'} style={{ marginLeft: 'auto' }}>
                  {t.status.replace(/_/g, ' ').toUpperCase()}
                </span>
              </div>
              <div style={{ fontSize: 10, color: '#5d6e7e' }}>
                {t.agent_name ?? t.kind} · ~${(t.total_cost_usd ?? 0).toFixed(3)} ·{' '}
                {(((t.input_tokens ?? 0) + (t.output_tokens ?? 0)) / 1000).toFixed(1)}k tok
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
