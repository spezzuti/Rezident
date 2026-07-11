import { getActiveBaseUrl, getActiveToken, isActiveLocal, reportAuthFailure } from './connections'

// Legacy token shims. These stay 1:1 with the old behavior — they read/write the
// `agentos_token` localStorage key — so no existing call site (main.tsx bootstrap,
// Login, App guard, raw fetches in CyberShell/Skills) changes. The connection store
// surfaces that same legacy token as the implicit LOCAL connection, so on the web the
// effective token is unchanged.
export function getToken(): string {
  // The active connection's token IS the legacy token on the web (implicit LOCAL).
  return getActiveToken()
}

export function setToken(token: string) {
  localStorage.setItem('agentos_token', token)
}

export function clearToken() {
  localStorage.removeItem('agentos_token')
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  // baseUrl is '' for the web/local case → `'' + path` is byte-for-byte today's
  // relative same-origin URL. A device/relay connection prepends its remote origin.
  const res = await fetch(getActiveBaseUrl() + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getActiveToken()}`,
      ...init.headers,
    },
  })
  if (res.status === 401) {
    if (isActiveLocal()) {
      // Web/legacy case: exactly today's behavior — drop the token, go to /login.
      clearToken()
      window.location.href = '/login'
    } else {
      // Device/relay case: there is no /login inside the app. Invalidate the active
      // connection and raise a signal (window 'agentos:auth-failed' + store flag) so a
      // later chunk can route to the pairing screen. Do NOT hard-redirect.
      reportAuthFailure()
    }
    throw new ApiError(401, 'unauthorized')
  }
  if (!res.ok) {
    let detail = res.statusText
    try {
      detail = (await res.json()).detail ?? detail
    } catch { /* not json */ }
    throw new ApiError(res.status, detail)
  }
  return res.json()
}

export const get = <T = any>(path: string) => api<T>(path)
export const post = <T = any>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
export const del = <T = any>(path: string) => api<T>(path, { method: 'DELETE' })
