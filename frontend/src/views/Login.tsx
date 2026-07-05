import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { setToken } from '../lib/api'
import { wsClient } from '../lib/ws'

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

export default function Login() {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const [booted, setBooted] = useState(false)
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
  return (
    <div className="relative flex min-h-screen items-center justify-center p-4">
      <div className="os-backdrop" />
      <div className="glass hud-corner w-full max-w-md p-8">
        <div className="text-center">
          <div className="neon-text font-mono text-3xl font-bold tracking-[0.3em] text-accent">
            {cyber ? (
              <>THE <span className="text-ink">GIBSON</span></>
            ) : (
              <>PIP-<span className="text-ink">OS</span><span className="align-super text-xs text-ink-dim">®</span></>
            )}
          </div>
          <div className="hud-label mt-2">{cyber ? 'Zero Cool // Access Terminal' : 'Overseer Terminal · Vault-Tec Approved'}</div>
        </div>

        <div className="mt-6 min-h-36 rounded-md border border-edge bg-input p-3 font-mono text-[11px] leading-relaxed text-ink-2">
          {bootLines.map((line, i) => (
            <div key={i} className="boot-line" style={{ animationDelay: `${i * 220}ms` }}>
              {line.includes('OK') ? (
                <>{line.split('OK')[0]}<span className="text-ok">OK</span></>
              ) : line.includes('BYPASSED') ? (
                <>{line.split('BYPASSED')[0]}<span className="text-ok">BYPASSED</span></>
              ) : (line.includes('AWAITING') || line.includes('HACK THE PLANET') || line.includes('ACCESS CODE')) ? (
                <span className="text-warn">{line}</span>
              ) : (
                line
              )}
            </div>
          ))}
          {booted && <span className="stream-cursor inline-block h-3 w-1.5 bg-accent align-middle" />}
        </div>

        <input
          autoFocus
          type="password"
          className="focus-glow mt-4 w-full rounded-md border border-edge bg-input px-3 py-2.5 font-mono text-sm text-ink outline-none transition-shadow focus:border-accent/50"
          placeholder="●●●●●●●● access token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {error && <div className="mt-2 font-mono text-xs text-err">{error}</div>}
        <button
          className="btn-glow mt-4 w-full rounded-md bg-accent/90 py-2.5 font-mono text-sm font-bold uppercase tracking-[0.2em] text-bg transition-all hover:bg-accent"
          onClick={submit}
        >
          Authenticate
        </button>
      </div>
    </div>
  )
}
