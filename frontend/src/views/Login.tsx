import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { setToken } from '../lib/api'
import { wsClient } from '../lib/ws'

const BOOT_LINES = [
  '> ROBCO INDUSTRIES (TM) TERMLINK PROTOCOL',
  '> PIP-OS(R) v3.0 — cold boot',
  '> reactor core ................... OK',
  '> vault door servos .............. OK',
  '> holotape archive ............... OK',
  '> companion registry ............. OK',
  '> AWAITING OVERSEER CREDENTIALS',
]

export default function Login() {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const [booted, setBooted] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    const t = setTimeout(() => setBooted(true), BOOT_LINES.length * 220 + 300)
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

  return (
    <div className="relative flex min-h-screen items-center justify-center p-4">
      <div className="os-backdrop" />
      <div className="glass hud-corner w-full max-w-md p-8">
        <div className="text-center">
          <div className="neon-text font-mono text-3xl font-bold tracking-[0.3em] text-accent">
            PIP-<span className="text-ink">OS</span><span className="align-super text-xs text-ink-dim">®</span>
          </div>
          <div className="hud-label mt-2">Overseer Terminal · Vault-Tec Approved</div>
        </div>

        <div className="mt-6 min-h-36 rounded-md border border-edge bg-input p-3 font-mono text-[11px] leading-relaxed text-ink-2">
          {BOOT_LINES.map((line, i) => (
            <div key={i} className="boot-line" style={{ animationDelay: `${i * 220}ms` }}>
              {line.includes('OK') ? (
                <>
                  {line.split('OK')[0]}
                  <span className="text-ok">OK</span>
                </>
              ) : line.includes('AWAITING') ? (
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
          className="mt-4 w-full rounded-md border border-edge bg-input px-3 py-2.5 font-mono text-sm text-ink outline-none transition-shadow focus:border-accent/50 focus:shadow-[0_0_20px_rgba(127,200,255,0.15)]"
          placeholder="●●●●●●●● access token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {error && <div className="mt-2 font-mono text-xs text-err">{error}</div>}
        <button
          className="mt-4 w-full rounded-md bg-accent/90 py-2.5 font-mono text-sm font-bold uppercase tracking-[0.2em] text-bg transition-all hover:bg-accent hover:shadow-[0_0_28px_rgba(127,200,255,0.4)]"
          onClick={submit}
        >
          Authenticate
        </button>
      </div>
    </div>
  )
}
