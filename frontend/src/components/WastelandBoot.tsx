import { useEffect, useState } from 'react'

/**
 * PIP-OS / ROBCO boot animation — the wasteland theme's full-screen power-on
 * that plays AFTER login (and on "reboot terminal"), the way GRID//OS boots
 * inside its deck. Pure CSS/text, matches the vault-terminal login. Click / any
 * key skips.
 */

type Tag = '' | 'ok' | 'amber'
const LINES: { t: string; tag: Tag }[] = [
  { t: '> OVERSEER CREDENTIALS ACCEPTED', tag: 'ok' },
  { t: '> ROBCO INDUSTRIES (TM) TERMLINK', tag: '' },
  { t: '> initializing PIP-OS(R) v4.0 ...', tag: '' },
  { t: '> reactor core spin-up .......... ONLINE', tag: 'ok' },
  { t: '> vault door servos ............. SEALED', tag: 'amber' },
  { t: '> holotape archive mounted ...... OK', tag: 'ok' },
  { t: '> companion registry ............ READY', tag: 'ok' },
  { t: '> S.P.E.C.I.A.L. subsystems ...... NOMINAL', tag: 'amber' },
  { t: '> PIP-OS READY', tag: 'amber' },
]
const STEP = 340
const HOLD = 1500

const AMBER = '#e8c14a'

export default function WastelandBoot({ onDone }: { onDone?: () => void }) {
  const [shown, setShown] = useState(0)
  const [done, setDone] = useState(false)

  useEffect(() => {
    const timers: number[] = []
    LINES.forEach((_, i) => timers.push(window.setTimeout(() => setShown(i + 1), 180 + i * STEP)))
    const total = 180 + LINES.length * STEP
    timers.push(window.setTimeout(() => setDone(true), total + 120))
    timers.push(window.setTimeout(() => onDone?.(), total + 120 + HOLD))
    const skip = () => onDone?.()
    window.addEventListener('keydown', skip)
    window.addEventListener('pointerdown', skip)
    return () => {
      timers.forEach(clearTimeout)
      window.removeEventListener('keydown', skip)
      window.removeEventListener('pointerdown', skip)
    }
  }, [onDone])

  const pct = Math.round((shown / LINES.length) * 100)

  return (
    <div
      className="wl-app"
      style={{
        position: 'fixed', inset: 0, zIndex: 99999, overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        animation: done ? 'wlb-fade .5s ease forwards' : undefined,
      }}
    >
      <div className="wl-equip wl-rust-bl" style={{ width: 'min(92vw, 520px)', overflow: 'hidden' }}>
        <div className="wl-chevron" style={{ borderRadius: '11px 11px 0 0' }} />
        <span className="wl-screw" style={{ top: 20, left: 7 }} />
        <span className="wl-screw wl-screw--rusty" style={{ top: 20, right: 7, transform: 'rotate(70deg)' }} />
        <span className="wl-screw wl-screw--bl" />
        <span className="wl-screw wl-screw--br" />

        <div style={{ padding: '20px 24px 24px' }}>
          {/* header: 76 badge + PIP-OS */}
          <div className="flex items-center gap-3" style={{ padding: '0 2px 14px' }}>
            <div
              style={{
                width: 38, height: 38, borderRadius: '50%',
                background: 'radial-gradient(circle at 35% 30%, #4a5a6a, #212a33)',
                border: '2px solid #d9ad2e', display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: AMBER, fontWeight: 700, fontSize: 14,
                boxShadow: `0 2px 4px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.15)${done ? ', 0 0 16px rgba(232,193,74,.6)' : ''}`,
                animation: done ? 'wlb-pulse 1s ease-in-out infinite' : undefined,
              }}
            >
              76
            </div>
            <div>
              <div style={{ fontSize: 19, fontWeight: 700, color: '#dfd8c6', letterSpacing: 2, textShadow: '0 1px 0 rgba(255,255,255,.1), 0 -1px 1px rgba(0,0,0,.6)' }}>
                {done ? 'WELCOME, OVERSEER' : 'PIP-OS'}
              </div>
              <div style={{ fontSize: 8, color: '#8fa0b0', letterSpacing: 2 }}>
                {done ? 'PIP-OS(R) v4.0 — ONLINE' : 'VAULT-TEC CERTIFIED'}
              </div>
            </div>
            <span className="wl-led wl-led--green wl-led--blink" style={{ marginLeft: 'auto' }} />
          </div>

          {/* boot log CRT */}
          <div className="wl-monitor-bezel">
            <div className="wl-crt wl-power-on" style={{ minHeight: 210, padding: '14px 16px', fontSize: 11.5, lineHeight: 1.75 }}>
              <div className="wl-scanlines" />
              <div className="wl-glare" />
              <div className="wl-scanbar" />
              <div className="relative">
                {LINES.slice(0, shown).map((line, i) => {
                  const color = line.tag === 'amber' ? AMBER : undefined
                  const shadow = line.tag === 'amber' ? '0 0 6px rgba(232,193,74,.35)' : undefined
                  const tail = line.tag === 'ok' ? line.t.match(/\b(ONLINE|OK|READY)\b\s*$/)?.[0] : undefined
                  return (
                    <div key={i} style={{ color, textShadow: shadow }}>
                      {tail ? (
                        <>{line.t.slice(0, line.t.length - tail.length)}<span className="wl-crt-text">{tail}</span></>
                      ) : (
                        line.t
                      )}
                    </div>
                  )
                })}
                {!done && shown > 0 && <span className="wl-cursor" />}
              </div>
            </div>
          </div>

          {/* reactor gauge */}
          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, letterSpacing: 2, color: '#8fa0b0', marginBottom: 5, fontFamily: 'var(--wl-mono, monospace)' }}>
              <span>REACTOR CORE</span>
              <span style={{ color: AMBER }}>{pct}%</span>
            </div>
            <div style={{ height: 8, background: 'rgba(0,0,0,.45)', border: '1px solid rgba(0,0,0,.6)', borderRadius: 2, overflow: 'hidden', boxShadow: 'inset 0 1px 2px rgba(0,0,0,.6)' }}>
              <div
                style={{
                  height: '100%', width: `${pct}%`,
                  background: 'linear-gradient(90deg, #6fae54, #8fbf4d)',
                  boxShadow: '0 0 8px rgba(143,191,77,.6)',
                  transition: 'width .24s ease',
                }}
              />
            </div>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes wlb-fade { from { opacity: 1 } to { opacity: 0 } }
        @keyframes wlb-pulse { 0%,100% { transform: scale(1) } 50% { transform: scale(1.08) } }
        @media (prefers-reduced-motion: reduce) { .wl-app [style*="wlb-pulse"] { animation: none !important } }
      `}</style>
    </div>
  )
}
