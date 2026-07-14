/**
 * Connection store — the transport seam.
 *
 * The web app is served same-origin: every REST/WS call is a relative path and the
 * bearer token lives in `localStorage['agentos_token']`. A Capacitor Android WebView,
 * by contrast, loads from `localhost`/`capacitor://` and must reach a *remote* desktop,
 * so it needs an explicit base URL + a per-device token. This module unifies both:
 *
 *   - A persisted list of `Connection`s ({id,label,baseUrl,token,kind}) with one active.
 *   - The legacy single-token web flow is the DEGENERATE case: when no explicit
 *     connection is active, the legacy `agentos_token` is surfaced as an *implicit*
 *     `{id:'local', baseUrl:'', kind:'direct'}` connection. baseUrl '' → callers build
 *     the exact same relative same-origin URLs as before, so nothing regresses on web.
 *
 * Back-compat unification (the contract every shim below relies on):
 *   getActiveConnection() =
 *     1. the explicit active connection, if activeId points at a real one;
 *     2. else, if a legacy `agentos_token` exists, the implicit LOCAL connection
 *        {id:'local', baseUrl:'', token:<legacy>, kind:'direct'};
 *     3. else null.
 *   setToken()/clearToken() (the legacy shims in api.ts) keep writing `agentos_token`
 *   verbatim, which the implicit LOCAL connection reads live — so main.tsx's `#token=`
 *   bootstrap and the Login flow work unchanged.
 */

import { Capacitor } from '@capacitor/core'

export type ConnectionKind = 'direct' | 'relay'

// The implicit LOCAL (same-origin) connection is a WEB concept: '' baseUrl means
// "the server that served this page". Inside the Capacitor APK the page comes from
// bundled assets — there is no same-origin server — so on native the implicit
// fallback must not exist. Without this, removing the last real connection let a
// stale legacy `agentos_token` resurrect a phantom LOCAL connection: the pairing
// gate never fired and the 401 path stranded the app on the (web-only) /login —
// a hard lockout with no way back to pairing.
const IS_NATIVE = Capacitor.isNativePlatform()

export interface Connection {
  id: string
  label: string
  baseUrl: string // '' means "same-origin" (the web/local case)
  token: string
  kind: ConnectionKind
}

const LS_CONNECTIONS = 'agentos_connections'
const LS_ACTIVE = 'agentos_active_conn'
const LS_LEGACY_TOKEN = 'agentos_token' // unchanged legacy key — the web login writes here

/** Well-known id for the implicit connection backed by the legacy `agentos_token`. */
export const LOCAL_CONN_ID = 'local'

// ---- in-memory cache (source of truth is localStorage; cache is kept in sync) ------

let _connections: Connection[] = loadConnections()
let _activeId: string | null = loadActiveId()

// The app can observe this to route a stranded device connection to a pairing screen
// (set on a 401 against a real connection; never set for the implicit LOCAL case).
let _authFailed = false

function loadConnections(): Connection[] {
  try {
    const raw = localStorage.getItem(LS_CONNECTIONS)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // tolerate partial/legacy shapes
    return parsed.filter((c) => c && typeof c.id === 'string' && typeof c.token === 'string')
  } catch {
    return []
  }
}

function loadActiveId(): string | null {
  try {
    return localStorage.getItem(LS_ACTIVE) || null
  } catch {
    return null
  }
}

function persist() {
  try {
    localStorage.setItem(LS_CONNECTIONS, JSON.stringify(_connections))
    if (_activeId) localStorage.setItem(LS_ACTIVE, _activeId)
    else localStorage.removeItem(LS_ACTIVE)
  } catch {
    /* private mode / locked-down env — in-memory state still works this session */
  }
}

// ---- subscribe / notify (minimal plain-module store, mirrors ws.ts's window events) -

type Listener = () => void
const _listeners = new Set<Listener>()

/** Subscribe to connection-state changes. Returns an unsubscribe fn. */
export function subscribe(fn: Listener): () => void {
  _listeners.add(fn)
  return () => _listeners.delete(fn)
}

function notify() {
  for (const fn of _listeners) {
    try {
      fn()
    } catch {
      /* a bad listener must not break the others */
    }
  }
}

// ---- reads ------------------------------------------------------------------------

/**
 * The implicit LOCAL connection derived from the legacy `agentos_token`, or null.
 * Read fresh from localStorage every time so `setToken()`/`clearToken()` (which write
 * the legacy key directly) take effect immediately without a notify round-trip.
 */
function implicitLocal(): Connection | null {
  if (IS_NATIVE) return null // no same-origin server inside the APK — web only
  let token = ''
  try {
    token = localStorage.getItem(LS_LEGACY_TOKEN) ?? ''
  } catch {
    token = ''
  }
  if (!token) return null
  return { id: LOCAL_CONN_ID, label: 'This device', baseUrl: '', token, kind: 'direct' }
}

export function getConnections(): Connection[] {
  return [..._connections]
}

export function getActiveConnection(): Connection | null {
  if (_activeId) {
    const found = _connections.find((c) => c.id === _activeId)
    if (found) return found
  }
  return implicitLocal()
}

/**
 * True when the active connection is the implicit LOCAL (legacy web) one — i.e. there
 * is no explicit active connection. This is the ONLY case that keeps the classic web
 * behavior of hard-redirecting to /login on a 401; a real device/relay connection must
 * not be stranded on /login (there is no /login inside the app).
 */
export function isActiveLocal(): boolean {
  if (IS_NATIVE) return false // native never hard-redirects to the web /login
  if (!_activeId) return true
  return !_connections.some((c) => c.id === _activeId)
}

/** Effective base URL of the active connection ('' for the web/local case). */
export function getActiveBaseUrl(): string {
  return getActiveConnection()?.baseUrl ?? ''
}

/** Effective bearer token of the active connection ('' when unauthenticated). */
export function getActiveToken(): string {
  return getActiveConnection()?.token ?? ''
}

// ---- writes -----------------------------------------------------------------------

/** Add (or replace, by id) a connection and make it active. */
export function addConnection(conn: Connection) {
  _connections = [..._connections.filter((c) => c.id !== conn.id), conn]
  _activeId = conn.id
  _authFailed = false
  persist()
  notify()
}

export function setActive(id: string) {
  if (!_connections.some((c) => c.id === id)) return
  _activeId = id
  _authFailed = false
  persist()
  notify()
}

export function removeConnection(id: string) {
  const next = _connections.filter((c) => c.id !== id)
  if (next.length === _connections.length) return
  _connections = next
  if (_activeId === id) _activeId = null
  persist()
  notify()
}

// ---- auth-failure signal ----------------------------------------------------------

/**
 * Called by api.ts when a real (non-LOCAL) connection gets a 401. Deselects the active
 * connection so the app's guard falls through to a pairing screen, raises a signal, and
 * dispatches a window event mirroring the `agentos:resync` idiom in ws.ts. It does NOT
 * hard-redirect and does NOT touch the legacy token (that path is handled in api.ts for
 * the LOCAL case).
 */
export function reportAuthFailure() {
  _authFailed = true
  _activeId = null
  persist()
  try {
    window.dispatchEvent(new CustomEvent('agentos:auth-failed'))
  } catch {
    /* non-browser env */
  }
  notify()
}

/** Whether a device/relay connection has failed auth and needs re-pairing. */
export function isAuthFailed(): boolean {
  return _authFailed
}

/** Clear the auth-failure flag (e.g. once the app has routed to pairing). */
export function clearAuthFailure() {
  if (!_authFailed) return
  _authFailed = false
  notify()
}
