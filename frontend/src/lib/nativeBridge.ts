/**
 * Native bridge (Capacitor only) — C6.
 *
 * Two jobs, both no-ops on the web (guarded by `Capacitor.isNativePlatform()`):
 *
 *  1. CONNECTION MIRROR. The active connection's {baseUrl, token, device_id} lives
 *     in WebView localStorage, which native code CANNOT read. The Approve/Deny
 *     notification actions run in a native BroadcastReceiver while the app is closed,
 *     so they need those creds. We mirror them into @capacitor/preferences, which
 *     persists to Android SharedPreferences (file "CapacitorStorage"). The native
 *     receiver + messaging service read that file directly. Re-mirrored on every
 *     connection change (pairing, switch, re-pair).
 *
 *  2. FCM REGISTRATION. Request the Android 13+ POST_NOTIFICATIONS runtime permission,
 *     obtain the FCM registration token via @capacitor/push-notifications, and
 *     POST it to /api/devices/{device_id}/fcm on the active connection. Token
 *     refresh is also handled natively (RezidentMessagingService.onNewToken re-POSTs
 *     using the mirrored creds), so this is the initial-registration path.
 *
 * Deep-link: tapping the notification BODY launches MainActivity with an extra that
 * MainActivity stashes into the same "CapacitorStorage" file under `rezident_pending_nav`.
 * `consumePendingNav()` reads+clears it so the app can navigate to /approvals on resume.
 */

import { Capacitor, registerPlugin } from '@capacitor/core'
import { getActiveConnection, subscribe, LOCAL_CONN_ID } from './connections'
import { post } from './api'

// SharedPreferences keys the native side reads (see RezidentHttp.java / ApprovalActionReceiver.java).
const K_BASE_URL = 'rezident_base_url'
const K_TOKEN = 'rezident_token'
const K_DEVICE_ID = 'rezident_device_id'
const K_PENDING_NAV = 'rezident_pending_nav'
const K_FULLSCREEN = 'rezident_fullscreen'

/** Minimal custom native plugin (Android). `set({enabled})` enters/exits immersive
 *  fullscreen instantly via MainActivity. No web implementation — every caller below
 *  is guarded by isNative(), so the web proxy is never invoked. */
interface ImmersivePlugin {
  set(options: { enabled: boolean }): Promise<void>
}
const Immersive = registerPlugin<ImmersivePlugin>('Immersive')

// Immersive-fullscreen choice lives in localStorage (like the CRT/sound prefs), default
// OFF. The System page toggle reads/writes it; initNativeBridge applies it on boot.
export const FULLSCREEN_KEY = 'agentos_fullscreen'

const isNative = () => {
  try {
    return Capacitor.isNativePlatform()
  } catch {
    return false
  }
}

/**
 * A "real" device connection is one minted by pairing (id === backend device_id,
 * a non-empty remote baseUrl). The implicit LOCAL web connection (id 'local',
 * baseUrl '') is never mirrored and never registers FCM — it isn't a paired device.
 */
function realDeviceConnection() {
  const c = getActiveConnection()
  if (!c || c.id === LOCAL_CONN_ID || !c.baseUrl) return null
  return c
}

function prefs() {
  // Dynamic import: the plugin only ships in the native build. Return the MODULE,
  // never the `Preferences` proxy: awaiting a value that resolves to a Capacitor
  // plugin proxy invokes the proxy's `.then`, which Capacitor treats as a native
  // method call ("Preferences.then() is not implemented on android") and throws —
  // that throw was silently swallowed, so the connection was never mirrored to
  // SharedPreferences and the native Approve/Deny receiver read null creds.
  return import('@capacitor/preferences')
}

/** Mirror (or clear) the active connection into SharedPreferences for the native receiver. */
export async function mirrorConnection(): Promise<void> {
  if (!isNative()) return
  try {
    const { Preferences: P } = await prefs()
    const c = realDeviceConnection()
    if (!c) {
      await Promise.all([
        P.remove({ key: K_BASE_URL }),
        P.remove({ key: K_TOKEN }),
        P.remove({ key: K_DEVICE_ID }),
      ])
      return
    }
    await Promise.all([
      P.set({ key: K_BASE_URL, value: c.baseUrl }),
      P.set({ key: K_TOKEN, value: c.token }),
      P.set({ key: K_DEVICE_ID, value: c.id }),
    ])
  } catch {
    /* preferences unavailable — the app still works, only background actions degrade */
  }
}

let _fcmToken = ''
let _lastRegisteredFor = '' // `${deviceId}:${token}` we last POSTed — de-dupes re-registration

/** POST the current FCM token to the active connection's device, if we have both. */
async function pushFcmToken(): Promise<void> {
  const c = realDeviceConnection()
  if (!c || !_fcmToken) return
  const key = `${c.id}:${_fcmToken}`
  if (key === _lastRegisteredFor) return
  try {
    await post(`/api/devices/${encodeURIComponent(c.id)}/fcm`, { fcm_token: _fcmToken })
    _lastRegisteredFor = key
  } catch {
    // Transient (offline / server asleep). Cleared marker → retried on next mirror/resume.
    _lastRegisteredFor = ''
  }
}

let _pushWired = false

/** Request notification permission, obtain the FCM token, and register listeners once. */
export async function initPush(): Promise<void> {
  if (!isNative()) return
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications')

    if (!_pushWired) {
      _pushWired = true
      await PushNotifications.addListener('registration', (t: { value: string }) => {
        _fcmToken = t.value
        void pushFcmToken()
      })
      await PushNotifications.addListener('registrationError', () => {
        /* no token this run; onNewToken (native) or the next launch retries */
      })
    }

    // Android 13+ runtime POST_NOTIFICATIONS. On <13 this resolves 'granted' immediately.
    const perm = await PushNotifications.checkPermissions()
    let receive = perm.receive
    if (receive === 'prompt' || receive === 'prompt-with-rationale') {
      receive = (await PushNotifications.requestPermissions()).receive
    }
    if (receive !== 'granted') return // user declined — no push, but no dead end

    // Kicks off token retrieval → fires the 'registration' listener above.
    await PushNotifications.register()
  } catch {
    /* push plugin unavailable — silently skip */
  }
}

/** Read and clear the deep-link nav target stashed by MainActivity on a notification-body tap. */
export async function consumePendingNav(): Promise<string | null> {
  if (!isNative()) return null
  try {
    const { Preferences: P } = await prefs()
    const { value } = await P.get({ key: K_PENDING_NAV })
    if (value) {
      await P.remove({ key: K_PENDING_NAV })
      return value
    }
  } catch {
    /* ignore */
  }
  return null
}

/**
 * Status bar (Capacitor only). Android 15 (targetSdk 35) forces edge-to-edge, which
 * would draw the WebView behind the status/navigation bars. The native side already
 * re-fits the window (MainActivity.onCreate: setDecorFitsSystemWindows + an inset
 * safety net), so here we only assert the STATUS bar presentation: no overlay, light
 * icons for our dark shell, and the shell's deepest background tone (--wl-bg-0). The
 * navigation bar is colored natively to the same tone. No CSS safe-area insets are
 * needed — the native layer keeps the WebView strictly between the bars.
 */
async function initStatusBar(): Promise<void> {
  if (!isNative()) return
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar')
    // Content sits below the bars, not under them (matches the native fitted window).
    await StatusBar.setOverlaysWebView({ overlay: false })
    // Style.Dark == light foreground icons, for our dark background.
    await StatusBar.setStyle({ style: Style.Dark })
    // Keep in sync with SYSTEM_BAR_COLOR in MainActivity.java (--wl-bg-0).
    await StatusBar.setBackgroundColor({ color: '#181f26' })
  } catch {
    /* status-bar plugin unavailable — native window defaults still apply */
  }
}

/** Read the persisted immersive-fullscreen choice (default OFF). Safe on the web. */
export function getFullscreen(): boolean {
  try {
    return localStorage.getItem(FULLSCREEN_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Persist + apply the immersive-fullscreen choice.
 *
 * Always records the choice in localStorage (so the toggle sticks). On native it then
 * (a) drives the Immersive plugin for an INSTANT apply — no app restart — and (b) mirrors
 * the flag into SharedPreferences so MainActivity.onCreate can honor it on the next cold
 * start before the WebView loads (no flash of bars). No native effect on the web.
 */
export async function setFullscreen(enabled: boolean): Promise<void> {
  try {
    localStorage.setItem(FULLSCREEN_KEY, enabled ? '1' : '0')
  } catch {
    /* private mode — the session still applies below */
  }
  if (!isNative()) return
  try {
    await Immersive.set({ enabled })
  } catch {
    /* plugin unavailable — window presentation stays as-is */
  }
  try {
    const { Preferences: P } = await prefs()
    await P.set({ key: K_FULLSCREEN, value: enabled ? '1' : '0' })
  } catch {
    /* preferences unavailable — this-session apply still worked */
  }
}

let _bridgeStarted = false

/** Idempotent entry point — call once from main.tsx. Mirrors now, re-mirrors on change. */
export function initNativeBridge(): void {
  if (!isNative() || _bridgeStarted) return
  _bridgeStarted = true
  void initStatusBar()
  // Immersive fullscreen: re-assert the saved choice now that JS is up. (Native also
  // reads the mirrored pref in MainActivity.onCreate for a flash-free cold start.)
  void setFullscreen(getFullscreen())
  void mirrorConnection()
  void initPush()
  subscribe(() => {
    void mirrorConnection()
    // A newly-active connection may need its FCM token registered against it.
    void pushFcmToken()
  })
  // App resumes from background (screen back on / task switch) — re-assert the token
  // registration in case the server was asleep when we first tried.
  try {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void pushFcmToken()
    })
  } catch {
    /* non-browser env */
  }
}
