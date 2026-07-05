import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { setToken } from '../lib/api'
import { wsClient } from '../lib/ws'

export default function Login() {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const navigate = useNavigate()

  async function submit() {
    setError('')
    const res = await fetch('/api/auth/check', { headers: { Authorization: `Bearer ${value.trim()}` } })
    if (res.ok) {
      setToken(value.trim())
      wsClient.connect()
      navigate('/')
    } else {
      setError('Invalid token')
    }
  }

  return (
    <div className="scanlines flex min-h-screen items-center justify-center bg-bg p-4">
      <div className="w-full max-w-sm rounded-xl border border-edge bg-panel p-6">
        <div className="text-center">
          <div className="font-mono text-2xl font-bold tracking-widest text-accent">AGENT<span className="text-ink">OS</span></div>
          <div className="mt-1 text-xs uppercase tracking-widest text-ink-dim">Mission Control</div>
        </div>
        <input
          autoFocus
          type="password"
          className="mt-6 w-full rounded-md border border-edge bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-accent"
          placeholder="Access token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {error && <div className="mt-2 text-sm text-err">{error}</div>}
        <button
          className="mt-4 w-full rounded-md bg-accent/90 py-2 text-sm font-semibold text-black hover:bg-accent"
          onClick={submit}
        >
          Authenticate
        </button>
      </div>
    </div>
  )
}
