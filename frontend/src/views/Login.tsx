import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { setToken } from '../lib/api'
import { wsClient } from '../lib/ws'
import CyberBoot, { loadBootVariant } from '../components/CyberBoot'

const BOOT_WASTELAND = [
  '> ROBCO INDUSTRIES (TM) TERMLINK PROTOCOL',
  '> PIP-OS(R) v4.0 — cold boot',
  '> reactor core ................... OK',
  '> vault door servos .............. OK',
  '> holotape archive ............... OK',
  '> companion registry ............. OK',
  '> AWAITING OVERSEER CREDENTIALS',
]
const BOOT_CYBER = [
  '> GIBSON MAINFRAME // uplink established',
  '> defeating ICE ................. BYPASSED',
  '> mounting /dev/da0 ............. OK',
  '> loading crew profiles ........ OK',
  '> RISC architecture is gonna change everything',
  '> HACK THE PLANET',
  '> ENTER ACCESS CODE',
]
const isCyber = () => document.documentElement.dataset.theme === 'cyber'

const PHOS_RED = '#dd8471'
const PHOS_YELLOW = '#e8c14a'

export default function Login() {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const [booted, setBooted] = useState(false)
  // In cyber mode, power on with the chosen Hackers boot once per session.
  const [poweringOn, setPoweringOn] = useState(
    isCyber() && !sessionStorage.getItem('agentos_booted'),
  )
  const navigate = useNavigate()

  useEffect(() => {
    const count = (isCyber() ? BOOT_CYBER : BOOT_WASTELAND).length
    const t = setTimeout(() => setBooted(true), count * 220 + 300)
    return () => clearTimeout(t)
  }, [])

  async function submit() {
    setError('')
    const res = await fetch('/api/auth/check', { headers: { Authorization: `Bearer ${value.trim()}` } })
    if (res.ok) {
      setToken(value.trim())
      wsClient.connect()
      navigate('/')
    } else {
      setError('> ACCESS DENIED — invalid token')
    }
  }

  const cyber = isCyber()
  const bootLines = cyber ? BOOT_CYBER : BOOT_WASTELAND
  if (poweringOn) {
    return (
      <CyberBoot
        variant={loadBootVariant()}
        onDone={() => { sessionStorage.setItem('agentos_booted', '1'); setPoweringOn(false) }}
      />
    )
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
                {cyber ? 'THE GIBSON' : 'PIP-OS'}
              </div>
              <div style={{ fontSize: 8, color: '#8fa0b0', letterSpacing: 2 }}>
                {cyber ? 'ZERO COOL // ACCESS TERMINAL' : 'VAULT-TEC CERTIFIED'}
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
                {bootLines.map((line, i) => (
                  <div key={i} className="boot-line" style={{ animationDelay: `${i * 220}ms` }}>
                    {line.includes('OK') ? (
                      <>{line.split('OK')[0]}<span className="wl-crt-text">OK</span></>
                    ) : line.includes('BYPASSED') ? (
                      <>{line.split('BYPASSED')[0]}<span className="wl-crt-text">BYPASSED</span></>
                    ) : (line.includes('AWAITING') || line.includes('HACK THE PLANET') || line.includes('ACCESS CODE')) ? (
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
        </div>
      </div>
    </div>
  )
}
