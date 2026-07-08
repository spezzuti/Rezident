/**
 * In-app "a task needs you" notifications: a browser Notification (also a native
 * toast inside the desktop WebView2 shell), a tasteful chime, and a tab
 * title/favicon badge for pending approvals. The server-side push (ntfy/Telegram/
 * webhook, see backend/agentos/notify.py) covers the "no tab open" case; this
 * covers "a tab is open somewhere, even backgrounded".
 */

const LS_ENABLED = 'agentos_notify_inapp'
const LS_SOUND = 'agentos_notify_sound'

let _enabled = localStorage.getItem(LS_ENABLED) !== '0' // default on
let _sound = localStorage.getItem(LS_SOUND) !== '0' // default on
let _ac: AudioContext | null = null
let _baseTitle = ''
let _origFavicon: string | null = null

export function getNotifyPrefs() {
  return {
    enabled: _enabled,
    sound: _sound,
    permission: typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
  }
}

export function setNotifyEnabled(v: boolean) {
  _enabled = v
  localStorage.setItem(LS_ENABLED, v ? '1' : '0')
}

export function setNotifySound(v: boolean) {
  _sound = v
  localStorage.setItem(LS_SOUND, v ? '1' : '0')
}

export async function requestNotifyPermission(): Promise<string> {
  if (typeof Notification === 'undefined') return 'unsupported'
  if (Notification.permission === 'granted') return 'granted'
  try {
    return await Notification.requestPermission()
  } catch {
    return Notification.permission
  }
}

// A soft two-note chime with a little body — deliberately not a chiptune blip.
function chime() {
  try {
    if (!_ac) {
      const AC = window.AudioContext || (window as any).webkitAudioContext
      if (!AC) return
      _ac = new AC()
    }
    const ac = _ac
    if (ac.state === 'suspended') ac.resume().catch(() => {})
    const now = ac.currentTime
    const master = ac.createGain()
    master.gain.value = 0.5
    master.connect(ac.destination)
    // two bell partials a fifth apart, gentle exponential decay
    const notes: [number, number][] = [[659.25, 0], [987.77, 0.14]] // E5 -> B5
    for (const [freq, at] of notes) {
      const t = now + at
      const o = ac.createOscillator()
      const o2 = ac.createOscillator()
      const g = ac.createGain()
      o.type = 'sine'
      o2.type = 'triangle'
      o.frequency.setValueAtTime(freq, t)
      o2.frequency.setValueAtTime(freq * 2.005, t) // detuned octave for shimmer
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.012)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9)
      const g2 = ac.createGain()
      g2.gain.value = 0.25
      o.connect(g)
      o2.connect(g2).connect(g)
      g.connect(master)
      o.start(t); o2.start(t)
      o.stop(t + 1.0); o2.stop(t + 1.0)
    }
  } catch {
    // audio is best-effort
  }
}

// Prime the AudioContext from a user gesture (browsers block audio otherwise).
export function primeAudio() {
  try {
    if (!_ac) {
      const AC = window.AudioContext || (window as any).webkitAudioContext
      if (AC) _ac = new AC()
    }
    if (_ac && _ac.state === 'suspended') _ac.resume().catch(() => {})
  } catch {
    /* ignore */
  }
}

export function testChime() {
  chime()
}

export function fireApproval(taskTitle: string, tool: string) {
  if (!_enabled) return
  if (_sound) chime()
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const n = new Notification('⏸ Approval needed — Rezident', {
        body: `${taskTitle}\nwants to run: ${tool}`,
        tag: 'agentos-approval',
        icon: _origFavicon || undefined,
      })
      n.onclick = () => {
        window.focus()
        n.close()
      }
    }
  } catch {
    /* Notification may throw in some embedded contexts */
  }
}

// ---- tab title + favicon badge -------------------------------------------------

function faviconLink(): HTMLLinkElement | null {
  return document.querySelector("link[rel~='icon']") as HTMLLinkElement | null
}

function drawBadgeFavicon(count: number): string | null {
  try {
    const c = document.createElement('canvas')
    c.width = 64
    c.height = 64
    const x = c.getContext('2d')
    if (!x) return null
    // dark rounded tile so the badge reads on any browser chrome
    x.fillStyle = '#0b0e16'
    x.beginPath()
    ;(x as any).roundRect ? (x as any).roundRect(4, 4, 56, 56, 12) : x.rect(4, 4, 56, 56)
    x.fill()
    // amber alert dot
    x.fillStyle = '#ffb000'
    x.beginPath()
    x.arc(32, 32, 22, 0, Math.PI * 2)
    x.fill()
    x.fillStyle = '#0b0e16'
    x.font = 'bold 34px system-ui, sans-serif'
    x.textAlign = 'center'
    x.textBaseline = 'middle'
    x.fillText(count > 9 ? '9+' : String(count), 32, 35)
    return c.toDataURL('image/png')
  } catch {
    return null
  }
}

export function setBadge(count: number) {
  if (!_baseTitle) _baseTitle = document.title.replace(/^\(\d+\+?\)\s*/, '')
  const link = faviconLink()
  if (_origFavicon === null && link) _origFavicon = link.href
  document.title = count > 0 ? `(${count > 9 ? '9+' : count}) ${_baseTitle}` : _baseTitle
  if (!link) return
  if (count > 0) {
    const url = drawBadgeFavicon(count)
    if (url) link.href = url
  } else if (_origFavicon) {
    link.href = _origFavicon
  }
}
