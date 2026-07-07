import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getToken, setToken } from '../lib/api'
import { wsClient } from '../lib/ws'

// The login is the PIP-OS gate for every theme. Cyber mode (GRID//OS) runs its
// own boot + login inside its iframe after you authenticate here, so this screen
// stays consistently PIP-OS rather than mixing in Hackers/cyber branding.
const BOOT_LINES = [
  '> ROBCO INDUSTRIES (TM) TERMLINK PROTOCOL',
  '> PIP-OS(R) v4.0 — cold boot',
  '> reactor core ................... OK',
  '> vault door servos .............. OK',
  '> holotape archive ............... OK',
  '> companion registry ............. OK',
  '> AWAITING OVERSEER CREDENTIALS',
]

const PHOS_RED = '#dd8471'
const PHOS_YELLOW = '#e8c14a'

// When rendered at /login there's no token yet (real auth). When the console
// replays the entry ceremony on a theme switch, the user is already authed, so
// this shows a "power on" screen (no token re-entry) and calls onProceed.
export default function Login({ onProceed }: { onProceed?: () => void } = {}) {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const [booted, setBooted] = useState(false)
  const navigate = useNavigate()
  const authed = !!getToken()

  useEffect(() => {
    const t = setTimeout(() => setBooted(true), BOOT_LINES.length * 220 + 300)
    return () => clearTimeout(t)
  }, [])

  function proceed() {
    if (onProceed) onProceed()
    else navigate('/')
  }

  async function submit() {
    if (authed) { proceed(); return }   // ceremonial re-entry — already authenticated
    setError('')
    const res = await fetch('/api/auth/check', { headers: { Authorization: `Bearer ${value.trim()}` } })
    if (res.ok) {
      setToken(value.trim())
      wsClient.connect()
      proceed()
    } else {
      setError('> ACCESS DENIED — invalid token')
    }
  }

  return (
    <div className="wl-app flex min-h-screen items-center justify-center p-4">
      {/* ---- vault terminal: steel equipment panel ---- */}
      <div className="wl-equip wl-rust-bl w-full" style={{ maxWidth: 460, overflow: 'hidden' }}>
        <div className="wl-chevron" style={{ borderRadius: '11px 11px 0 0' }} />
        <span className="wl-screw" style={{ top: 20, left: 7 }} />
        <span className="wl-screw wl-screw--rusty" style={{ top: 20, right: 7, transform: 'rotate(70deg)' }} />
        <span className="wl-screw wl-screw--bl" />
        <span className="wl-screw wl-screw--br" />

        <div style={{ padding: '18px 22px 22px' }}>
          {/* ---- 76 badge + PIP-OS header ---- */}
          <div className="flex items-center gap-3" style={{ padding: '0 2px 14px' }}>
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: '50%',
                background: 'radial-gradient(circle at 35% 30%, #4a5a6a, #212a33)',
                border: '2px solid #d9ad2e',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: PHOS_YELLOW,
                fontWeight: 700,
                fontSize: 13,
                boxShadow: '0 2px 4px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.15)',
              }}
            >
              76
            </div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#dfd8c6', letterSpacing: 2, textShadow: '0 1px 0 rgba(255,255,255,.1), 0 -1px 1px rgba(0,0,0,.6)' }}>
                PIP-OS
              </div>
              <div style={{ fontSize: 8, color: '#8fa0b0', letterSpacing: 2 }}>
                VAULT-TEC CERTIFIED
              </div>
            </div>
            <span className="wl-led wl-led--green wl-led--blink" style={{ marginLeft: 'auto' }} />
          </div>

          {/* ---- boot sequence CRT ---- */}
          <div className="wl-monitor-bezel">
            <div className="wl-crt wl-power-on" style={{ minHeight: 168, padding: '12px 14px', fontSize: 11, lineHeight: 1.7 }}>
              <div className="wl-scanlines" />
              <div className="wl-glare" />
              <div className="wl-scanbar" />
              <div className="relative">
                {(authed ? [...BOOT_LINES.slice(0, -1), '> OVERSEER RECOGNISED — STANDING BY'] : BOOT_LINES).map((line, i) => (
                  <div key={i} className="boot-line" style={{ animationDelay: `${i * 220}ms` }}>
                    {line.includes('OK') ? (
                      <>{line.split('OK')[0]}<span className="wl-crt-text">OK</span></>
                    ) : line.includes('AWAITING') || line.includes('STANDING BY') ? (
                      <span style={{ color: PHOS_YELLOW, textShadow: '0 0 6px rgba(232,193,74,.35)' }}>{line}</span>
                    ) : (
                      line
                    )}
                  </div>
                ))}
                {booted && <span className="wl-cursor" />}
              </div>
            </div>
          </div>

          {authed ? (
            /* ceremonial power-on: already authenticated, just enter the console */
            <div className="wl-btn-housing mt-4 w-full" style={{ display: 'block' }}>
              <button
                autoFocus
                className="wl-btn w-full"
                style={{ padding: '10px 16px' }}
                onClick={submit}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
              >
                ▸ ENTER OVERSEER CONSOLE
              </button>
            </div>
          ) : (
            <>
              {/* ---- access code input ---- */}
              <input
                autoFocus
                type="password"
                className="wl-input mt-4 w-full"
                placeholder="ENTER ACCESS CODE"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
              />
              {error && (
                <div className="wl-mono mt-2" style={{ fontSize: 11, color: PHOS_RED, textShadow: '0 0 5px rgba(221,132,113,.4)' }}>
                  {error}
                </div>
              )}
              <div className="wl-btn-housing mt-4 w-full" style={{ display: 'block' }}>
                <button className="wl-btn w-full" style={{ padding: '10px 16px' }} onClick={submit}>
                  AUTHENTICATE
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
