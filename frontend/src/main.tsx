import React from 'react'
import ReactDOM from 'react-dom/client'
import App, { initSkin } from './App'
import { setToken } from './lib/api'
import { initNativeBridge } from './lib/nativeBridge'
import './index.css'

// Desktop / deep-link auto-login: a token in the URL — the desktop app passes it
// as a `#token=...` fragment (kept out of the server log and browser history);
// bookmarkable LAN links may use `?token=...`. Either is stored to localStorage,
// then both are stripped from the URL.
function bootstrapToken() {
  try {
    const search = new URLSearchParams(window.location.search)
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const t = hash.get('token') || search.get('token')
    if (t) {
      setToken(t)
      search.delete('token')
      hash.delete('token')
      const qs = search.toString()
      const hs = hash.toString()
      window.history.replaceState({}, '', window.location.pathname + (qs ? '?' + qs : '') + (hs ? '#' + hs : ''))
    }
  } catch {
    /* non-browser / locked-down env — ignore */
  }
}

bootstrapToken()
initSkin()
// Capacitor-only: mirror the active connection to native storage (for the FCM
// Approve/Deny receiver) + register for push. No-op on the web.
initNativeBridge()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
