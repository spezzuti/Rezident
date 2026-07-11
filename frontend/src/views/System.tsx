import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { api, get, post } from '../lib/api'
import { useStore } from '../store'
import { CRT_SKINS, getCrtSkin, setCrtSkin } from '../lib/theme'
import { getSoundOn, setSoundOn, getSoundCats, setSoundCat, SOUND_CATS, sfx } from '../lib/sound'
import { getNotifyPrefs, setNotifySound, requestNotifyPermission, testChime } from '../lib/notify'
import { Capacitor } from '@capacitor/core'
import { initPush, getFullscreen, setFullscreen } from '../lib/nativeBridge'

// Companion (Android) app version. The phone 403s on the desktop self-update, so app
// updates ship as a new APK — this is a static build stamp, not the server version.
const APP_VERSION = '0.1.0'

interface DetectedAgent {
  key: string
  name: string
  installed: boolean
  path: string | null
  version: string | null
  blurb: string
}

interface Check { key: string; label: string; ok: boolean; detail: string }

interface Environment {
  agentos_version: string
  sdk_version: string
  agents: DetectedAgent[]
  checklist: Check[]
}

interface Integration {
  key: string
  name: string
  icon: string
  blurb: string
  enabled: boolean
  endpoint: string
  model: string
  ssh: string
  notes: string
  transport?: string
  kind?: string        // api | oauth | local | bridge — which fields this slot needs
  transports?: string[] // legal connection modes; >1 renders a mode picker
  default_model?: string
  token_hint?: string
  has_token: boolean
  last_status?: string
  last_detail?: string
  last_checked?: string
}

const put = (path: string, body: unknown) => api(path, { method: 'PUT', body: JSON.stringify(body) })

const AGENT_ICON: Record<string, string> = {
  claude: '✳', codex: '◍', gemini: '✦', openclaw: '🦞', hermes: '⚚',
  aider: '◇', ollama: '🦙', gh: '⌥', docker: '🐳', node: '⬢', python: '🐍', git: '⎇',
}

function Toggle({ on, onClick, title }: { on: boolean; onClick: () => void; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      className={`wl-toggle${on ? ' on' : ''}`}
      style={{ border: 'none', padding: 0, flex: 'none' }}
      onClick={onClick}
    >
      <span className="wl-toggle-lever" />
    </button>
  )
}

/* sign-in transports: the vendor CLI holds an account sign-in — no key stored here.
   CONNECT runs the CLI hidden; it opens the sign-in in the browser, poof. */
const SIGNIN: Record<string, { bin: string; account: string; note: string }> = {
  'codex-cli': { bin: 'codex', account: 'ChatGPT', note: 'CONNECT opens a ChatGPT sign-in in your browser — log in once and Codex is live. No API key.' },
}

function modeLabel(t: string, kind: string): string {
  if (t === 'openai') return kind === 'bridge' ? 'HTTP API' : 'API KEY'
  return { 'codex-cli': 'CHATGPT SIGN-IN', 'hermes-cli': 'SSH · CLI', acp: 'SSH · ACP' }[t] ?? t.toUpperCase()
}

function IntegrationCard({ integration, onSaved }: { integration: Integration; onSaved: () => void }) {
  const kind = integration.kind ?? 'bridge'
  const modes = integration.transports ?? ['openai']
  const [cfg, setCfg] = useState({ enabled: integration.enabled, endpoint: integration.endpoint ?? '', token: '', model: integration.model ?? '', ssh: integration.ssh ?? '', transport: integration.transport ?? modes[0] })
  const isCli = cfg.transport === 'hermes-cli'
  const isAcp = cfg.transport === 'acp'
  const isSsh = isCli || isAcp  // both talk over SSH and need only the ssh destination
  const signin = SIGNIN[cfg.transport]  // account sign-in via the vendor CLI — no key
  // oauth slots flipped to their API KEY mode are hosted providers too: key + fixed endpoint
  const keyed = kind === 'api' || (kind === 'oauth' && !signin)
  // TEST/SEND become available once the saved config is usable for its connection
  const configured = signin ? true : isSsh ? !!integration.ssh : keyed ? integration.has_token : !!integration.endpoint
  // enabled cards mount collapsed to a summary line; the chevron (or name) expands
  const [open, setOpen] = useState(!integration.enabled)
  const [dirty, setDirty] = useState(false)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null)
  const [loginMsg, setLoginMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [loginUrl, setLoginUrl] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [reply, setReply] = useState<{ ok: boolean; text: string } | null>(null)
  const set = (u: Partial<typeof cfg>) => { setCfg({ ...cfg, ...u }); setDirty(true) }

  async function save() {
    await put(`/api/integrations/${integration.key}`, cfg)
    setDirty(false)
    setCfg({ ...cfg, token: '' })  // token is now saved server-side; clear the field
    onSaved()
  }

  // CONNECT: start the hidden sign-in, poll it, and flip the card green by itself
  async function connect() {
    if (connecting) return
    setConnecting(true)
    setLoginUrl('')
    setLoginMsg({ ok: true, text: 'starting the sign-in…' })
    type Login = { running: boolean; done: boolean; ok: boolean; url: string; detail: string }
    try {
      let st = await post<Login>(`/api/integrations/${integration.key}/login`)
      const t0 = Date.now()
      while (!st.done && Date.now() - t0 < 6 * 60_000) {
        setLoginMsg({ ok: true, text: st.detail || 'waiting for the browser sign-in…' })
        if (st.url) setLoginUrl(st.url)
        await new Promise((r) => setTimeout(r, 2500))
        st = await get<Login>(`/api/integrations/${integration.key}/login`)
      }
      if (st.done && st.ok) {
        // signed in = connected & enabled — the backend already persisted the slot
        // as enabled on login success, so no separate Save is needed. Verify the
        // link, then refetch: the card remounts (key includes enabled) as a
        // connected, enabled card with the dirty Save state discarded.
        setLoginMsg({ ok: true, text: 'signed in ✓ — verifying the link…' })
        setLoginUrl('')
        await test()
        setLoginMsg(null)
        onSaved()
      } else {
        setLoginMsg({ ok: false, text: st.detail || 'the sign-in did not complete — hit CONNECT to retry' })
      }
    } catch (e) {
      setLoginMsg({ ok: false, text: e instanceof Error ? e.message : 'could not start the sign-in' })
    } finally {
      setConnecting(false)
    }
  }

  async function test() {
    setTesting(true); setResult(null)
    try { setResult(await post<{ ok: boolean; detail: string }>(`/api/integrations/${integration.key}/test`)) }
    catch { setResult({ ok: false, detail: 'test request failed' }) }
    finally { setTesting(false) }
  }

  async function send() {
    if (!prompt.trim()) return
    setSending(true); setReply(null)
    try {
      const r = await post<{ reply?: string }>(`/api/integrations/${integration.key}/dispatch`, { prompt })
      setReply({ ok: true, text: r.reply ?? '(no reply)' })
    } catch (e) {
      setReply({ ok: false, text: e instanceof Error ? e.message : 'dispatch failed' })
    } finally {
      setSending(false)
    }
  }

  // live result if just tested; else the stored probe verdict — but only once the
  // slot is actually set up (an unconfigured card doesn't need an "unreachable" nag)
  const status = result
    ? { ok: result.ok, text: (result.ok ? '● CONNECTED' : '✗ NOT CONNECTED') + (result.detail ? ' · ' + result.detail : '') }
    : integration.last_status && configured
      ? { ok: integration.last_status === 'reachable', text: (integration.last_status === 'reachable' ? '● connected' : '✗ not connected') + (integration.last_detail ? ' · ' + integration.last_detail : '') }
      : null

  // collapsed = enabled card folded to its summary line; unsaved edits force it open
  const expanded = cfg.enabled && (open || dirty)
  const summary = `${modeLabel(cfg.transport, kind)} · ${(
    signin ? cfg.model || `${signin.account} account`
    : isSsh ? cfg.ssh
    : keyed ? (integration.has_token ? `key saved · ${cfg.model || integration.default_model || 'default model'}` : 'key needed')
    : cfg.endpoint
  ) || 'not configured'}`

  return (
    <div className="wl-equip" style={{ position: 'relative', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10, opacity: cfg.enabled ? 1 : 0.85 }}>
      <span className="wl-screw wl-screw--tl" />
      <span className="wl-screw wl-screw--br" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="wl-tile" style={{ width: 38, height: 38, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, color: 'var(--wl-phos-g)', textShadow: '0 0 8px var(--wl-phos-g-glow)' }}>
          {integration.icon}
        </span>
        <div style={{ minWidth: 0, flex: 1, cursor: cfg.enabled ? 'pointer' : 'default' }} onClick={() => cfg.enabled && setOpen(!open)}>
          <div style={{ fontFamily: "'Chakra Petch',sans-serif", fontSize: 12, fontWeight: 700, letterSpacing: 1.5, color: 'var(--wl-cream)', display: 'flex', alignItems: 'center', gap: 6 }}>
            {integration.name.toUpperCase()}
            {cfg.enabled && status && (
              <span title={status.text} style={{ fontSize: 8, color: status.ok ? 'var(--wl-phos-g)' : 'var(--wl-red-hi)', textShadow: status.ok ? '0 0 5px var(--wl-phos-g-glow)' : 'none' }}>●</span>
            )}
          </div>
          <div className="wl-mono" style={{ fontSize: 9.5, color: 'var(--wl-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {cfg.enabled && !expanded ? summary : integration.blurb}
          </div>
        </div>
        {cfg.enabled && (
          <button
            type="button"
            title={expanded ? 'collapse' : 'configure'}
            className="wl-mono"
            style={{ flex: 'none', width: 22, height: 22, background: 'none', border: '1px solid rgba(255,255,255,.14)', color: 'var(--wl-dim)', cursor: 'pointer', fontSize: 10, lineHeight: 1 }}
            onClick={() => setOpen(!open)}
          >
            {expanded ? '▾' : '▸'}
          </button>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
          <Toggle on={cfg.enabled} onClick={() => { set({ enabled: !cfg.enabled }); if (!cfg.enabled) setOpen(true) }} title={cfg.enabled ? 'power off' : 'power on'} />
          <span className="wl-microlabel">{cfg.enabled ? 'ON' : 'OFF'}</span>
        </div>
      </div>
      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* mode picker ONLY when the slot genuinely has more than one way in
              (Gemini/Qwen: sign-in vs key · Hermes: HTTP/CLI/ACP) — no dropdown */}
          {modes.length > 1 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {modes.map((t) => {
                const on = cfg.transport === t
                return (
                  <button key={t} type="button" className="wl-mono" onClick={() => set({ transport: t })}
                          style={{ fontSize: 9, letterSpacing: 1.2, padding: '5px 10px', cursor: 'pointer', flex: 1,
                                   background: on ? 'rgba(232,193,74,.10)' : 'none',
                                   border: `1px solid ${on ? 'var(--wl-yellow)' : 'rgba(255,255,255,.14)'}`,
                                   color: on ? 'var(--wl-yellow)' : 'var(--wl-dim)' }}>
                    {modeLabel(t, kind)}
                  </button>
                )
              })}
            </div>
          )}
          {signin ? (
            <>
              <div className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-dim)', lineHeight: 1.5, padding: '0 2px' }}>{signin.note}</div>
              <button type="button" className="wl-btn wl-btn--steel"
                      style={{ fontSize: 10, padding: '6px 14px', alignSelf: 'flex-start', opacity: connecting ? 0.6 : 1, pointerEvents: connecting ? 'none' : 'auto' }}
                      onClick={connect}>
                {connecting ? '⚿ SIGNING IN…' : `⚿ CONNECT — ${signin.account.toUpperCase()} SIGN-IN`}
              </button>
              {loginMsg && (
                <div className="wl-mono" style={{ fontSize: 9.5, lineHeight: 1.5, color: loginMsg.ok ? 'var(--wl-phos-g)' : 'var(--wl-red-hi)' }}>{loginMsg.text}</div>
              )}
              {connecting && loginUrl && (
                <button type="button" className="wl-mono"
                        style={{ fontSize: 9.5, alignSelf: 'flex-start', background: 'none', border: '1px solid rgba(255,255,255,.14)', color: 'var(--wl-cream)', cursor: 'pointer', padding: '4px 10px' }}
                        onClick={() => window.open(loginUrl, '_blank')}>
                  no tab appeared? open the sign-in page ↗
                </button>
              )}
              <input className="wl-input" style={{ width: '100%' }}
                     placeholder="model (optional) — blank = the CLI's default"
                     value={cfg.model} onChange={(e) => set({ model: e.target.value })} />
              <input className="wl-input" style={{ width: '100%' }}
                     placeholder={`${signin.bin} binary (optional) — blank = auto-detect on PATH`}
                     value={cfg.endpoint} onChange={(e) => set({ endpoint: e.target.value })} />
            </>
          ) : isSsh ? (
            <>
              <input className="wl-input" style={{ width: '100%' }}
                     placeholder="ssh — user@host[:port] of the box Hermes runs on (e.g. agent@192.168.1.50)"
                     value={cfg.ssh} onChange={(e) => set({ ssh: e.target.value })} />
              <div className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-dim)', lineHeight: 1.5, padding: '0 2px' }}>
                {isAcp
                  ? <>Runs <code>hermes acp</code> over SSH — a live agent session with <b>streaming replies</b>, native multi-turn memory, and tool-call visibility. Needs passwordless SSH; auth is your key.</>
                  : <>Runs <code>hermes -z "&lt;prompt&gt;"</code> over SSH and returns its reply. Needs passwordless (key-based) SSH to that box. No endpoint/token — auth is your SSH key.</>}
              </div>
            </>
          ) : keyed ? (
            <>
              <input className="wl-input" style={{ width: '100%' }}
                     type="password"
                     placeholder={integration.has_token ? 'API key — saved (type to replace)' : (integration.token_hint || 'API key')}
                     value={cfg.token} onChange={(e) => set({ token: e.target.value })} />
              <input className="wl-input" style={{ width: '100%' }}
                     placeholder={`model (optional) — default: ${integration.default_model || 'provider default'}`}
                     value={cfg.model} onChange={(e) => set({ model: e.target.value })} />
              <div className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '0 2px' }}>
                endpoint → {cfg.endpoint}
              </div>
            </>
          ) : kind === 'local' ? (
            <>
              <input className="wl-input" style={{ width: '100%' }}
                     placeholder="endpoint — http://127.0.0.1:11434"
                     value={cfg.endpoint} onChange={(e) => set({ endpoint: e.target.value })} />
              <input className="wl-input" style={{ width: '100%' }}
                     placeholder={`model — ${integration.default_model || 'as served locally'}`}
                     value={cfg.model} onChange={(e) => set({ model: e.target.value })} />
            </>
          ) : (
            <>
              <input className="wl-input" style={{ width: '100%' }}
                     placeholder="endpoint — e.g. http://127.0.0.1:8642 (OpenAI-compatible base URL)"
                     value={cfg.endpoint} onChange={(e) => set({ endpoint: e.target.value })} />
              <input className="wl-input" style={{ width: '100%' }}
                     placeholder="model — blank = the runtime's default"
                     value={cfg.model} onChange={(e) => set({ model: e.target.value })} />
              <input className="wl-input" style={{ width: '100%' }}
                     type="password"
                     placeholder={integration.has_token ? 'token — saved (type to replace) · optional' : 'token (optional)'}
                     value={cfg.token} onChange={(e) => set({ token: e.target.value })} />
              <input className="wl-input" style={{ width: '100%' }}
                     placeholder="ssh (optional) — user@host[:port] to tunnel to a remote runtime"
                     value={cfg.ssh} onChange={(e) => set({ ssh: e.target.value })} />
            </>
          )}
        </div>
      )}
      {expanded && (dirty || configured) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {dirty && (
            <button type="button" className="wl-btn wl-btn--steel" style={{ fontSize: 10, padding: '6px 14px' }} onClick={save}>
              SAVE
            </button>
          )}
          {!dirty && configured && (
            <button type="button" className="wl-btn wl-btn--steel" style={{ fontSize: 10, padding: '6px 14px', opacity: testing ? 0.5 : 1, pointerEvents: testing ? 'none' : 'auto' }} onClick={test}>
              {testing ? 'TESTING…' : 'TEST CONNECTION'}
            </button>
          )}
          {status && (
            <span className="wl-mono" style={{ fontSize: 9.5, color: status.ok ? 'var(--wl-phos-g)' : 'var(--wl-red-hi)', textShadow: status.ok ? '0 0 5px var(--wl-phos-g-glow)' : 'none' }}>
              {status.text}
            </span>
          )}
        </div>
      )}
      {expanded && !dirty && configured && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid rgba(255,255,255,.07)', paddingTop: 8 }}>
          <div className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-faint)', letterSpacing: 1.5 }}>SEND A PROMPT</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="wl-input" style={{ flex: 1 }} placeholder="prompt the agent…" value={prompt}
                   onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} />
            <button type="button" className="wl-btn wl-btn--steel" style={{ fontSize: 10, padding: '6px 12px', opacity: sending ? 0.5 : 1, pointerEvents: sending ? 'none' : 'auto' }} onClick={send}>
              {sending ? '…' : 'SEND'}
            </button>
          </div>
          {reply && (
            <div className="wl-mono" style={{ fontSize: 10, lineHeight: 1.55, color: reply.ok ? 'var(--wl-cream)' : 'var(--wl-red-hi)', background: 'rgba(0,0,0,.28)', border: '1px solid rgba(255,255,255,.06)', padding: '7px 9px', maxHeight: 150, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
              {reply.text}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

interface NotifyConfig {
  channel: string
  ntfy_topic: string
  telegram_chat: string
  webhook_url: string
  on_approval: boolean
  on_finish: boolean
  has_telegram_token: boolean
}

const CHANNELS: [string, string][] = [['off', 'Off'], ['ntfy', 'ntfy'], ['telegram', 'Telegram'], ['webhook', 'Webhook']]

function NotifyPanel() {
  const [cfg, setCfg] = useState<NotifyConfig>({ channel: 'off', ntfy_topic: '', telegram_chat: '', webhook_url: '', on_approval: true, on_finish: false, has_telegram_token: false })
  const [tgToken, setTgToken] = useState('')
  const [prefs, setPrefs] = useState(getNotifyPrefs())
  const [msg, setMsg] = useState('')
  useEffect(() => { get<NotifyConfig>('/api/notifications').then(setCfg).catch(() => {}) }, [])
  const upd = (p: Partial<NotifyConfig>) => setCfg((c) => ({ ...c, ...p }))
  async function save() {
    setMsg('saving…')
    try {
      const saved = (await put('/api/notifications', { ...cfg, telegram_token: tgToken || null })) as NotifyConfig
      setCfg(saved); setTgToken(''); setMsg('saved ✓')
    } catch { setMsg('save failed') }
  }
  async function test() {
    setMsg('sending…')
    try {
      const r = await post<{ ok: boolean; detail: string }>('/api/notifications/test')
      setMsg(r.ok ? 'push sent ✓' : 'failed — ' + r.detail)
    } catch { setMsg('test failed') }
  }
  async function enableBrowser() { await requestNotifyPermission(); setPrefs(getNotifyPrefs()) }
  // inside the desktop shell there is no browser settings page — a denial there
  // means the app build predates the WebView2 permission auto-grant
  const inShell = typeof (window as any).pywebview !== 'undefined'
  const permLabel = prefs.permission === 'granted' ? '● desktop alerts ON'
    : prefs.permission === 'denied' ? (inShell ? '✕ blocked — update the Rezident app' : '✕ blocked (unblock in browser)')
    : prefs.permission === 'unsupported' ? '— unsupported here' : '○ enable desktop alerts'
  return (
    <div className="wl-equip" style={{ position: 'relative', padding: '12px 14px 14px' }}>
      <span className="wl-screw wl-screw--tl" />
      <span className="wl-screw wl-screw--tr" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 4px 10px' }}>
        <span className="wl-sectionlabel">Notifications</span>
        <span className="wl-mono" style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--wl-dim)' }}>PING ME WHEN A TASK NEEDS ME</span>
      </div>
      {/* label ABOVE control (uniform alignment) */}
      <div className="wl-tile" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', marginBottom: 8 }}>
        <span className="wl-mono" style={{ fontSize: 12, color: 'var(--wl-dim)' }}>THIS DEVICE</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button type="button" className="wl-btn wl-btn--steel" style={{ padding: '5px 12px', fontSize: 11 }} onClick={enableBrowser}>{permLabel}</button>
          <Toggle on={prefs.sound} onClick={() => { setNotifySound(!prefs.sound); setPrefs(getNotifyPrefs()) }} title="chime" />
          <span className="wl-mono" style={{ fontSize: 11, color: 'var(--wl-dim)' }}>chime</span>
          <button type="button" className="wl-btn wl-btn--steel" style={{ padding: '5px 10px', fontSize: 10 }} onClick={() => testChime()}>♪ test</button>
        </div>
      </div>
      <div className="wl-tile" style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* label ABOVE control (uniform alignment) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
          <span className="wl-mono" style={{ fontSize: 12, color: 'var(--wl-dim)' }}>PHONE PUSH</span>
          <div style={{ display: 'flex', gap: 6 }}>
            {CHANNELS.map(([v, l]) => {
              const on = cfg.channel === v
              return (
                <button key={v} type="button" className="wl-btn wl-btn--steel" style={{ padding: '4px 11px', fontSize: 11, ...(on ? { boxShadow: 'inset 0 0 0 1px var(--wl-yellow)', color: 'var(--wl-yellow)' } : {}) }} onClick={() => upd({ channel: v })}>{l}</button>
              )
            })}
          </div>
        </div>
        {cfg.channel === 'ntfy' && (
          <input className="wl-input" placeholder="ntfy topic — e.g. agentos-alerts (subscribe to it in the ntfy app)" value={cfg.ntfy_topic} onChange={(e) => upd({ ntfy_topic: e.target.value })} />
        )}
        {cfg.channel === 'telegram' && (
          <>
            <input className="wl-input" type="password" placeholder={cfg.has_telegram_token ? 'bot token — saved (blank keeps it)' : 'bot token from @BotFather'} value={tgToken} onChange={(e) => setTgToken(e.target.value)} />
            <input className="wl-input" placeholder="chat id — send your bot a message, then check getUpdates" value={cfg.telegram_chat} onChange={(e) => upd({ telegram_chat: e.target.value })} />
          </>
        )}
        {cfg.channel === 'webhook' && (
          <input className="wl-input" placeholder="webhook URL — any endpoint that accepts a JSON POST" value={cfg.webhook_url} onChange={(e) => upd({ webhook_url: e.target.value })} />
        )}
        {cfg.channel !== 'off' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Toggle on={cfg.on_approval} onClick={() => upd({ on_approval: !cfg.on_approval })} /><span className="wl-mono" style={{ fontSize: 11, color: 'var(--wl-dim)' }}>on approval needed</span></span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Toggle on={cfg.on_finish} onClick={() => upd({ on_finish: !cfg.on_finish })} /><span className="wl-mono" style={{ fontSize: 11, color: 'var(--wl-dim)' }}>on task finished</span></span>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="wl-btn-housing"><button type="button" className="wl-btn" style={{ fontSize: 11 }} onClick={save}>SAVE</button></div>
          {cfg.channel !== 'off' && <button type="button" className="wl-btn wl-btn--steel" style={{ padding: '6px 12px', fontSize: 11 }} onClick={test}>TEST PUSH ▸</button>}
          {msg && <span className="wl-mono" style={{ fontSize: 11, color: 'var(--wl-yellow)' }}>{msg}</span>}
        </div>
      </div>
    </div>
  )
}

type NetworkStatus = {
  allow_insecure_lan: boolean
  requested_host: string | null
  effective_host: string | null
  downgraded: boolean
  warning: string | null
}

/** LAN-exposure override. Off by default: the server binds loopback only, so the
 *  bearer token never crosses a plain-http LAN. Flipping it ON opts into a 0.0.0.0
 *  bind (phones / other machines can reach the deck) — takes effect on the NEXT
 *  restart, since the bind host is fixed at startup. Tailscale is the safer path. */
function SecurityPanel() {
  const [net, setNet] = useState<NetworkStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => { get<NetworkStatus>('/api/system/network').then(setNet).catch(() => {}) }, [])

  async function toggle() {
    if (!net || busy) return
    const next = !net.allow_insecure_lan
    setBusy(true)
    try {
      const r = await post<NetworkStatus>('/api/system/security', { allow_insecure_lan: next })
      setNet(r)
      setMsg('saved ✓ — takes effect on next restart')
      sfx.confirm()
    } catch {
      setMsg('save failed')
      sfx.deny()
    }
    setBusy(false)
  }

  const on = !!net?.allow_insecure_lan
  const eff = net?.effective_host ?? '…'
  // a running server that requested LAN but got downgraded (override was off at boot)
  const downgraded = !!net?.downgraded

  return (
    <div className="wl-equip" style={{ position: 'relative', padding: '12px 14px 14px', ...(on ? { boxShadow: 'inset 0 0 0 1px rgba(229,167,71,.35)' } : {}) }}>
      <span className="wl-screw wl-screw--tl" />
      <span className="wl-screw wl-screw--tr" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 4px 10px' }}>
        <span className="wl-sectionlabel">Network Access</span>
        <span className="wl-mono" style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--wl-dim)' }}>
          BIND EXPOSURE
        </span>
      </div>
      <div className="wl-tile" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 12px' }}>
        {/* label ABOVE control (uniform alignment) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
          <div className="wl-mono" style={{ fontSize: 12, color: on ? 'var(--wl-yellow)' : 'var(--wl-cream)', fontWeight: 700 }}>
            ALLOW LAN ACCESS (INSECURE)
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Toggle on={on} onClick={toggle} title={on ? 'restrict to this PC' : 'allow LAN access'} />
            <span className="wl-microlabel" style={{ flex: 'none' }}>{on ? 'ON' : 'OFF'}</span>
            <div className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-faint)', lineHeight: 1.5, flex: 1, minWidth: 220 }}>
              Binds 0.0.0.0 so phones / other machines can reach this server. The bearer token then
              crosses your LAN in plaintext — prefer Tailscale. Takes effect on restart.
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', borderTop: '1px solid rgba(255,255,255,.07)', paddingTop: 8 }}>
          <span className={`wl-led ${downgraded ? 'wl-led--yellow' : on ? 'wl-led--yellow' : 'wl-led--green'}`} />
          <span className="wl-mono" style={{ fontSize: 10, color: 'var(--wl-dim)' }}>
            CURRENTLY BOUND: <span style={{ color: 'var(--wl-cream)' }}>{eff}</span>
            {eff === '127.0.0.1' ? ' (this PC only)' : ' (reachable on LAN)'}
          </span>
          {downgraded && (
            <span className="wl-mono" style={{ fontSize: 9.5, color: 'var(--wl-yellow)' }}>
              · LAN was requested but refused at boot — enable above, then restart
            </span>
          )}
          {on && !downgraded && eff === '127.0.0.1' && (
            <span className="wl-mono" style={{ fontSize: 9.5, color: 'var(--wl-yellow)' }}>
              · restart to bind the LAN
            </span>
          )}
          {msg && <span className="wl-mono" style={{ fontSize: 9.5, color: 'var(--wl-yellow)', marginLeft: 'auto' }}>{msg}</span>}
        </div>
      </div>
    </div>
  )
}

type AutostartStatus = {
  supported: boolean
  installed: boolean
  state?: string
  execute?: string
  arguments?: string
}

/** Opt-in boot-level autostart: a Windows Scheduled Task (S4U, runs as this
 *  user, no login needed). Never installed by default — INSTALL here is the
 *  only way in, and Windows' own admin prompt is the final consent gate. */
function AutostartPanel() {
  const [st, setSt] = useState<AutostartStatus | null>(null)
  const [host, setHost] = useState<'0.0.0.0' | '127.0.0.1'>('0.0.0.0')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    get<AutostartStatus>('/api/system/autostart').then(setSt).catch(() => {})
  }, [])

  async function apply(enable: boolean) {
    setBusy(true)
    setMsg(enable ? 'waiting for the Windows admin prompt on this machine…' : 'removing — approve the admin prompt…')
    try {
      const r = await post<{ ok: boolean; detail: string; status: AutostartStatus }>('/api/system/autostart', { enable, host })
      setMsg(r.detail)
      setSt(r.status)
      if (r.ok) sfx.confirm()
      else sfx.deny()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'request failed')
      sfx.deny()
    }
    setBusy(false)
  }

  const running = st?.state === 'Running'
  const led = !st?.installed ? '' : running ? 'wl-led--green' : 'wl-led--yellow'

  return (
    <div className="wl-equip" style={{ position: 'relative', padding: '12px 14px 14px' }}>
      <span className="wl-screw wl-screw--tl" />
      <span className="wl-screw wl-screw--tr" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 4px 10px' }}>
        <span className="wl-sectionlabel">Autostart</span>
        <span className="wl-mono" style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--wl-dim)' }}>
          OPTIONAL · BOOT-LEVEL
        </span>
      </div>
      <div className="wl-tile" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className={`wl-led ${led}`} />
          <span className="wl-mono" style={{ fontSize: 12, color: 'var(--wl-dim)' }}>
            BOOT SERVICE: {st === null ? '…' : !st.supported ? 'WINDOWS ONLY' : st.installed ? `INSTALLED${st.state ? ` (${st.state.toUpperCase()})` : ''}` : 'NOT INSTALLED'}
          </span>
          {st?.installed && st.execute && (
            <span className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-faint)' }}>
              {st.execute} {st.arguments}
            </span>
          )}
        </div>
        {st?.supported && !st.installed && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-faint)', letterSpacing: 1.5 }}>REACH</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {([['0.0.0.0', 'LAN + TAILNET'], ['127.0.0.1', 'THIS PC ONLY']] as const).map(([v, label]) => (
              <button
                key={v}
                type="button"
                className="wl-btn wl-btn--steel"
                style={{ padding: '5px 12px', fontSize: 10, ...(host === v ? { boxShadow: 'inset 0 0 0 1px var(--wl-yellow)', color: 'var(--wl-yellow)' } : {}) }}
                onClick={() => setHost(v)}
              >
                {host === v ? '● ' : '○ '}{label}
              </button>
            ))}
            </div>
          </div>
        )}
        {st?.supported && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="wl-btn wl-btn--steel"
              disabled={busy}
              style={busy ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
              onClick={() => apply(!st.installed)}
            >
              {st.installed ? '✕ REMOVE BOOT SERVICE' : '▸ INSTALL BOOT SERVICE'}
            </button>
            {msg && <span className="wl-mono" style={{ fontSize: 11, color: 'var(--wl-yellow)' }}>{msg}</span>}
          </div>
        )}
        <span className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-faint)' }}>
          starts the server at machine boot, before login, as your user — token auth still gates every request.
          install/remove shows a Windows admin prompt on this machine (not doable from the phone).
          the desktop app detects the service and opens its window against it.
        </span>
      </div>
    </div>
  )
}

type UpdateStatus = {
  current: string; latest: string; newer: boolean; update_available: boolean
  flavor: string; auto_check: boolean; skipped: boolean; snoozed: boolean
  snooze_until: string; release_url: string; notes: string; checked_at: string; error: string
}
type UpdateJob = { state: string; pct: number; detail: string; error: string }

const UPDATE_ACTIVE = ['checking', 'downloading', 'verifying', 'swapping', 'restarting']

/** Desktop self-update. Feature-parity twin of GRID//OS's SYSTEM-tab update panel.
 *  Every prompt carries NOT NOW (snooze 24h — the user's hard requirement); every
 *  error state carries RETRY + an open-releases link, so there's never a dead end. */
function UpdatePanel() {
  const [st, setSt] = useState<UpdateStatus | null>(null)
  const [job, setJob] = useState<UpdateJob | null>(null)
  const [busy, setBusy] = useState(false)
  const pushTicker = useStore((s) => s.pushTicker)
  const setUpdateStatus = useStore((s) => s.setUpdateStatus)

  const load = useCallback(async (force = false) => {
    try {
      const s = force ? await post<UpdateStatus>('/api/update/check') : await get<UpdateStatus>('/api/update/status')
      setSt(s)
      // Keep the shared store slice (nav badge / App announce) in sync with the panel's
      // own fetch — e.g. clears the badge once an update is applied or the state changes.
      setUpdateStatus(!!s.update_available && !!s.latest, s.latest ?? '')
    } catch { /* status never hard-fails server-side; a transport error just leaves the last view */ }
  }, [setUpdateStatus])

  useEffect(() => { load(false) }, [load])

  // One COMMS push per newly-seen version — the depot ping shouldn't nag on every mount.
  useEffect(() => {
    if (!st?.update_available || !st.latest) return
    if (localStorage.getItem('agentos_update_announced') === st.latest) return
    localStorage.setItem('agentos_update_announced', st.latest)
    pushTicker({ ts: new Date().toISOString(), tone: 'info',
      text: `◤ UPDATE AVAILABLE — Rezident v${st.latest} · System page to install` })
  }, [st?.update_available, st?.latest, pushTicker])

  // Poll the apply job while it's in flight; refresh status when it settles.
  const pollJob = useCallback(() => {
    let stop = false
    const tick = async () => {
      if (stop) return
      try {
        const j = await get<UpdateJob>('/api/update/apply')
        setJob(j)
        if (UPDATE_ACTIVE.includes(j.state)) { setTimeout(tick, 1000); return }
      } catch { /* fall through to settle */ }
      load(false)
    }
    tick()
    return () => { stop = true }
  }, [load])

  async function install() {
    setBusy(true)
    try {
      const j = await post<UpdateJob>('/api/update/apply')
      setJob(j)
      pollJob()
    } catch { sfx.deny() }
    setBusy(false)
  }

  async function act(path: string, sound = true) {
    setBusy(true)
    try {
      const s = await post<UpdateStatus>(path)
      setSt(s)
      if (sound) sfx.confirm()
    } catch { sfx.deny() }
    setBusy(false)
  }

  async function toggleAuto() {
    if (!st) return
    try {
      const s = await post<UpdateStatus>('/api/update/settings', { auto_check: !st.auto_check })
      setSt(s)
      sfx.click()
    } catch { sfx.deny() }
  }

  const relUrl = st?.release_url || 'https://github.com/spezzuti/Rezident/releases'
  const OpenReleases = ({ label }: { label: string }) => (
    <a href={relUrl} target="_blank" rel="noreferrer" className="wl-btn wl-btn--steel"
       style={{ textDecoration: 'none', display: 'inline-block' }}>{label}</a>
  )

  // progress + error take precedence over the resting available/held/up-to-date views
  const active = job && UPDATE_ACTIVE.includes(job.state)
  const jobErr = job?.state === 'error' ? (job.error || '') : ''
  const checkErr = !jobErr && !active ? (st?.error || '') : ''
  const unknownFlavor = st?.flavor === 'unknown' && st?.newer
  // a newer build the user has parked: skipped (set aside) or snoozed (deferred).
  // These are distinct, recoverable states — never a false "UP TO DATE".
  const restKnown = !active && !jobErr && !checkErr && !unknownFlavor
  const isSkipped = !!(restKnown && st?.newer && st?.skipped)
  const isSnoozed = !!(restKnown && st?.newer && st?.snoozed && !st?.skipped)
  const snoozeHours = (() => {
    const t = st?.snooze_until ? Date.parse(st.snooze_until) : NaN
    return Number.isFinite(t) ? Math.max(0, Math.ceil((t - Date.now()) / 3_600_000)) : 0
  })()

  let led = 'wl-led--green'
  if (active) led = 'wl-led--yellow'
  else if (jobErr || checkErr || unknownFlavor) led = 'wl-led--red'
  else if (st?.update_available || isSkipped || isSnoozed) led = 'wl-led--yellow'

  const btnPrimary = { boxShadow: 'inset 0 0 0 1px var(--wl-yellow)', color: 'var(--wl-yellow)' } as const

  function progressLine(): string {
    if (!job) return ''
    if (job.state === 'downloading') return `▓ DOWNLOADING… ${job.pct}%`
    if (job.state === 'verifying') return '▓ VERIFYING…'
    if (job.state === 'swapping' || job.state === 'restarting') return '▓ INSTALLING — Rezident will restart'
    return '▓ PREPARING…'
  }

  function errorLine(): string {
    const e = (jobErr || checkErr).toLowerCase()
    if (e.includes('checksum')) return '✗ CHECKSUM MISMATCH — build discarded for safety'
    if (jobErr && !e.includes('depot') && !e.includes('download')) return `✗ INSTALL FAILED — ${job?.error}`
    return '✗ DOWNLOAD FAILED — the depot didn’t answer'
  }

  return (
    <div id="update-panel" className="wl-equip" style={{ position: 'relative', padding: '12px 14px 14px' }}>
      <span className="wl-screw wl-screw--tl" />
      <span className="wl-screw wl-screw--tr" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 4px 10px' }}>
        <span className="wl-sectionlabel">System Update</span>
        <span className="wl-mono" style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--wl-dim)' }}>
          DESKTOP SELF-UPDATE
        </span>
      </div>
      <div className="wl-tile" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className={`wl-led ${led}`} />
          {active ? (
            <span className="wl-mono" style={{ fontSize: 12, color: 'var(--wl-yellow)' }}>{progressLine()}</span>
          ) : jobErr || checkErr ? (
            <span className="wl-mono" style={{ fontSize: 12, color: 'var(--wl-red-hi)' }}>{errorLine()}</span>
          ) : unknownFlavor ? (
            <span className="wl-mono" style={{ fontSize: 12, color: 'var(--wl-yellow)' }}>
              ⚠ CAN’T SELF-UPDATE THIS COPY — grab the new build ↗
            </span>
          ) : st?.update_available ? (
            <span className="wl-mono" style={{ fontSize: 12, color: 'var(--wl-yellow)' }}>
              ◤ NEW BUILD ON THE AIR — REZIDENT v{st.latest}
            </span>
          ) : isSkipped ? (
            <span className="wl-mono" style={{ fontSize: 12, color: 'var(--wl-yellow)' }}>
              ◇ BUILD v{st?.latest} ON FILE — SKIPPED
            </span>
          ) : isSnoozed ? (
            <span className="wl-mono" style={{ fontSize: 12, color: 'var(--wl-yellow)' }}>
              ◇ UPDATE SNOOZED — v{st?.latest} returns in ~{snoozeHours}h
            </span>
          ) : (
            <span className="wl-mono" style={{ fontSize: 12, color: 'var(--wl-phos-g)' }}>
              ✓ UP TO DATE — v{st?.current ?? '…'} (latest)
            </span>
          )}
        </div>

        {!active && !jobErr && !checkErr && !unknownFlavor && st?.update_available && (
          <span className="wl-mono" style={{ fontSize: 9.5, color: 'var(--wl-faint)' }}>
            you’re running v{st.current} · a fresher build is waiting in the depot
          </span>
        )}

        {isSkipped && (
          <span className="wl-mono" style={{ fontSize: 9.5, color: 'var(--wl-faint)' }}>
            you chose to sit this one out · you’re on v{st?.current}
          </span>
        )}

        {/* action row */}
        {!active && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {jobErr || checkErr ? (
              <>
                <button type="button" className="wl-btn wl-btn--steel" disabled={busy}
                  onClick={() => (jobErr ? install() : load(true))}>↻ RETRY</button>
                <OpenReleases label="open releases ↗" />
              </>
            ) : unknownFlavor ? (
              <OpenReleases label="open releases ↗" />
            ) : st?.update_available ? (
              <>
                <button type="button" className="wl-btn wl-btn--steel" disabled={busy}
                  style={btnPrimary} onClick={install}>▸ INSTALL UPDATE</button>
                <button type="button" className="wl-btn wl-btn--steel" disabled={busy}
                  onClick={() => act('/api/update/snooze')}>NOT NOW</button>
                <button type="button" className="wl-btn wl-btn--steel" disabled={busy}
                  style={{ opacity: 0.65 }} onClick={() => act('/api/update/skip')}>SKIP THIS BUILD</button>
                <OpenReleases label="RELEASE NOTES ↗" />
              </>
            ) : isSkipped ? (
              <>
                <button type="button" className="wl-btn wl-btn--steel" disabled={busy}
                  style={btnPrimary} onClick={() => act('/api/update/unskip')}>RECONSIDER</button>
                <OpenReleases label="RELEASE NOTES ↗" />
              </>
            ) : isSnoozed ? (
              <button type="button" className="wl-btn wl-btn--steel" disabled={busy}
                style={btnPrimary} onClick={() => act('/api/update/unsnooze')}>SHOW NOW</button>
            ) : (
              <button type="button" className="wl-btn wl-btn--steel" disabled={busy}
                onClick={() => load(true)}>CHECK NOW</button>
            )}
          </div>
        )}

        {/* auto-check toggle — label ABOVE control (uniform alignment) */}
        <div style={{ borderTop: '1px solid var(--wl-line)', paddingTop: 10, marginTop: 2 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
            <span className="wl-mono" style={{ fontSize: 11, color: 'var(--wl-cream)' }}>AUTO-CHECK FOR UPDATES</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Toggle on={!!st?.auto_check} onClick={toggleAuto} title="auto-check for updates" />
              <span className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-faint)' }}>
                pings the depot on boot and every few hours
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* NATIVE ONLY — companion-app panel that stands in for the desktop UpdatePanel.
   A device 403s on /api/update/apply, so there's nothing to install here: app updates
   arrive as a new APK. Shows the app build stamp and, clearly labelled, the
   server/desktop versions this phone is paired to. */
function NativeAppPanel({ serverVersion, sdkVersion }: { serverVersion?: string; sdkVersion?: string }) {
  return (
    <div className="wl-equip" style={{ position: 'relative', padding: '12px 14px 14px' }}>
      <span className="wl-screw wl-screw--tl" />
      <span className="wl-screw wl-screw--tr" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 4px 10px' }}>
        <span className="wl-sectionlabel">Companion App</span>
        <span className="wl-mono" style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--wl-dim)' }}>
          ANDROID BUILD
        </span>
      </div>
      <div className="wl-tile" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className="wl-led wl-led--green" />
          <span className="wl-mono" style={{ fontSize: 12, color: 'var(--wl-phos-g)', textShadow: '0 0 6px var(--wl-phos-g-glow)' }}>
            REZIDENT COMPANION v{APP_VERSION}
          </span>
        </div>
        <span className="wl-mono" style={{ fontSize: 9.5, color: 'var(--wl-faint)', lineHeight: 1.5 }}>
          app updates arrive by installing a new APK — there's no in-app self-update on the phone.
        </span>
        <div style={{ borderTop: '1px solid var(--wl-line)', paddingTop: 10, marginTop: 2, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="wl-mono" style={{ fontSize: 9, letterSpacing: 1.5, color: 'var(--wl-dim)' }}>PAIRED SERVER · DESKTOP</span>
          <span className="wl-mono" style={{ fontSize: 10, color: 'var(--wl-cream)' }}>
            REZIDENT v{serverVersion ?? '…'} · CLAUDE-AGENT-SDK {sdkVersion ?? '…'}
          </span>
        </div>
      </div>
    </div>
  )
}

/* NATIVE ONLY — minimal push row that stands in for the desktop NotifyPanel. The phone
   can't touch the channel config (ntfy/telegram/webhook/FCM service-account all 403 on a
   device); all it needs is its own POST_NOTIFICATIONS grant + FCM registration, which
   initPush() (nativeBridge) handles. We reflect the live permission state via
   PushNotifications.checkPermissions(). */
function NativePushPanel() {
  const [perm, setPerm] = useState<string>('unknown')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const check = useCallback(async () => {
    try {
      const { PushNotifications } = await import('@capacitor/push-notifications')
      const p = await PushNotifications.checkPermissions()
      setPerm(p.receive)
    } catch {
      setPerm('unknown')
    }
  }, [])

  useEffect(() => { void check() }, [check])

  async function enable() {
    if (busy) return
    setBusy(true)
    setMsg('requesting…')
    try {
      await initPush()
      await check()
      setMsg('')
      sfx.confirm()
    } catch {
      setMsg('could not enable push')
      sfx.deny()
    }
    setBusy(false)
  }

  const on = perm === 'granted'
  const denied = perm === 'denied'
  const led = on ? 'wl-led--green' : denied ? 'wl-led--red' : 'wl-led--yellow'
  const status = on ? '● PUSH ON — this phone is registered'
    : denied ? '✕ BLOCKED — turn notifications on in Android settings'
    : '○ PUSH OFF — enable to get approval & task pings'

  return (
    <div className="wl-equip" style={{ position: 'relative', padding: '12px 14px 14px' }}>
      <span className="wl-screw wl-screw--tl" />
      <span className="wl-screw wl-screw--tr" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 4px 10px' }}>
        <span className="wl-sectionlabel">Push Notifications</span>
        <span className="wl-mono" style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--wl-dim)' }}>PING ME WHEN A TASK NEEDS ME</span>
      </div>
      <div className="wl-tile" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className={`wl-led ${led}`} />
          <span className="wl-mono" style={{ fontSize: 12, color: on ? 'var(--wl-phos-g)' : denied ? 'var(--wl-red-hi)' : 'var(--wl-cream)', textShadow: on ? '0 0 6px var(--wl-phos-g-glow)' : 'none' }}>
            {status}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" className="wl-btn wl-btn--steel" disabled={busy}
            style={busy ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
            onClick={enable}>
            {busy ? 'WORKING…' : on ? '↻ RE-CHECK' : '▸ ENABLE NOTIFICATIONS'}
          </button>
          {msg && <span className="wl-mono" style={{ fontSize: 10, color: 'var(--wl-yellow)' }}>{msg}</span>}
        </div>
      </div>
    </div>
  )
}

export default function System() {
  const [env, setEnv] = useState<Environment | null>(null)
  const [integrations, setIntegrations] = useState<Integration[]>([])
  const [scanning, setScanning] = useState(false)
  const [crtSkin, setCrt] = useState(getCrtSkin())
  const [sndOn, setSnd] = useState(getSoundOn())
  const [sndCats, setSndCats] = useState(getSoundCats())
  // Immersive-fullscreen choice (native-only control below). Default OFF.
  const [fullscreen, setFs] = useState(getFullscreen())
  // update indicator comes off the shared store slice (kept in sync by UpdatePanel's
  // own /api/update/status fetch) — no second /api/update call from the About block.
  const updateAvailable = useStore((s) => s.updateAvailable)
  const updateLatest = useStore((s) => s.updateLatest)
  // Companion (Android) app: the device token 403s on every admin mutation on this
  // page, so under Capacitor we slim it to app-relevant, read-only surface. The
  // desktop and mobile-WEB render is byte-for-byte unchanged (native === false there).
  const native = Capacitor.isNativePlatform()

  const refresh = useCallback((force = false) => {
    setScanning(true)
    get<Environment>(`/api/system/environment${force ? '?force=1' : ''}`)
      .then(setEnv)
      .finally(() => setScanning(false))
    get<Integration[]>('/api/integrations').then(setIntegrations)
  }, [])

  useEffect(() => refresh(false), [refresh])

  const installed = env?.agents.filter((a) => a.installed) ?? []
  const missing = env?.agents.filter((a) => !a.installed) ?? []
  const ghRepo = 'https://github.com/spezzuti/Rezident'
  const ghLink: CSSProperties = { fontSize: 10, textDecoration: 'none' }

  return (
    <div className="min-h-full p-4 md:p-6" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* workshop header — v0.1.6 minimal: label + version/SDK line + RESCAN */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div className="wl-sectionlabel">System · Setup</div>
          <div className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-faint)', marginTop: 3 }}>
            REZIDENT v{env?.agentos_version ?? '…'} · CLAUDE-AGENT-SDK {env?.sdk_version ?? '…'}
            {updateAvailable && (
              <span
                role="button"
                tabIndex={0}
                title="open the update panel"
                onClick={() => document.getElementById('update-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                style={{ color: 'var(--wl-yellow)', cursor: 'pointer', marginLeft: 8 }}
              >
                · v{updateLatest} available →
              </span>
            )}
          </div>
        </div>
        <div className="wl-divider" style={{ flex: 1 }} />
        <div className="wl-btn-housing">
          <button
            type="button"
            className="wl-btn wl-btn--steel"
            style={scanning ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
            disabled={scanning}
            onClick={() => refresh(true)}
          >
            {scanning ? 'SCANNING…' : '⟳ RESCAN'}
          </button>
        </div>
      </div>

      {/* desktop self-update — on native, the app-version panel stands in for it */}
      {native ? <NativeAppPanel serverVersion={env?.agentos_version} sdkVersion={env?.sdk_version} /> : <UpdatePanel />}

      {/* interface — CRT screen colour (scoped to comms / active-agent CRTs) */}
      <div className="wl-equip" style={{ position: 'relative', padding: '12px 14px 14px' }}>
        <span className="wl-screw wl-screw--tl" />
        <span className="wl-screw wl-screw--tr" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 4px 10px' }}>
          <span className="wl-sectionlabel">Interface</span>
          <span className="wl-mono" style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--wl-dim)' }}>
            CRT SCREENS ONLY
          </span>
        </div>
        {/* label ABOVE control (uniform alignment) */}
        <div className="wl-tile" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px' }}>
          <span className="wl-mono" style={{ fontSize: 12, color: 'var(--wl-dim)' }}>CRT PHOSPHOR</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 6 }}>
              {CRT_SKINS.map((s) => {
                const on = crtSkin === s.value
                return (
                  <button
                    key={s.value || 'green'}
                    type="button"
                    className="wl-btn wl-btn--steel"
                    style={{ padding: '5px 14px', fontSize: 11, ...(on ? { boxShadow: 'inset 0 0 0 1px var(--wl-yellow)', color: 'var(--wl-yellow)' } : {}) }}
                    onClick={() => { setCrtSkin(s.value); setCrt(s.value) }}
                  >
                    {on ? '● ' : '○ '}{s.label}
                  </button>
                )
              })}
            </div>
            <span className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-faint)', marginLeft: 'auto' }}>
              tints comms &amp; active-agent screens · the theme knob is on the console header
            </span>
          </div>
        </div>
        {/* label ABOVE control (uniform alignment) */}
        <div className="wl-tile" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', marginTop: 8 }}>
          <span className="wl-mono" style={{ fontSize: 12, color: 'var(--wl-dim)' }}>UI SOUND</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 6 }}>
              {([true, false] as const).map((v) => {
                const on = sndOn === v
                return (
                  <button
                    key={String(v)}
                    type="button"
                    className="wl-btn wl-btn--steel"
                    style={{ padding: '5px 14px', fontSize: 11, ...(on ? { boxShadow: 'inset 0 0 0 1px var(--wl-yellow)', color: 'var(--wl-yellow)' } : {}) }}
                    onClick={() => { setSoundOn(v); setSnd(v); if (v) sfx.confirm() }}
                  >
                    {on ? '● ' : '○ '}{v ? 'ON' : 'OFF'}
                  </button>
                )
              })}
            </div>
            <span className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-faint)' }}>·</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', opacity: sndOn ? 1 : 0.4 }}>
              {SOUND_CATS.map((c) => {
                const catOn = sndCats[c.key] !== false
                return (
                  <button
                    key={c.key}
                    type="button"
                    className="wl-btn wl-btn--steel"
                    title={c.hint}
                    disabled={!sndOn}
                    style={{ padding: '5px 12px', fontSize: 10, ...(catOn && sndOn ? { boxShadow: 'inset 0 0 0 1px var(--wl-yellow)', color: 'var(--wl-yellow)' } : {}), cursor: sndOn ? 'pointer' : 'default' }}
                    onClick={() => {
                      const next = !catOn
                      setSoundCat(c.key, next)
                      setSndCats(getSoundCats())
                      if (next && c.key !== 'boot') { c.key === 'ui' ? sfx.click() : sfx.confirm() }
                    }}
                  >
                    {catOn ? '● ' : '○ '}{c.label}
                  </button>
                )
              })}
            </div>
            <span className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-faint)', marginLeft: 'auto' }}>
              per-category mute — the notify chime has its own switch below
            </span>
          </div>
        </div>
      </div>

      {/* display — NATIVE ONLY: immersive fullscreen. Hides the status + nav bars and
          lets them return transiently on an edge swipe (Android immersive-sticky). Desktop
          and mobile-web never render this (there are no system bars to reclaim there). */}
      {native && (
        <div className="wl-equip" style={{ position: 'relative', padding: '12px 14px 14px' }}>
          <span className="wl-screw wl-screw--tl" />
          <span className="wl-screw wl-screw--tr" />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 4px 10px' }}>
            <span className="wl-sectionlabel">Display</span>
            <span className="wl-mono" style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--wl-dim)' }}>
              THIS PHONE
            </span>
          </div>
          {/* label ABOVE control (uniform alignment) */}
          <div className="wl-tile" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px' }}>
            <span className="wl-mono" style={{ fontSize: 12, color: 'var(--wl-dim)' }}>FULLSCREEN</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: 6 }}>
                {([true, false] as const).map((v) => {
                  const on = fullscreen === v
                  return (
                    <button
                      key={String(v)}
                      type="button"
                      className="wl-btn wl-btn--steel"
                      style={{ padding: '5px 14px', fontSize: 11, ...(on ? { boxShadow: 'inset 0 0 0 1px var(--wl-yellow)', color: 'var(--wl-yellow)' } : {}) }}
                      onClick={() => { setFs(v); void setFullscreen(v); v ? sfx.confirm() : sfx.click() }}
                    >
                      {on ? '● ' : '○ '}{v ? 'ON' : 'OFF'}
                    </button>
                  )
                })}
              </div>
              <span className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-faint)', marginLeft: 'auto' }}>
                hides the status &amp; nav bars — swipe from an edge to show them
              </span>
            </div>
          </div>
        </div>
      )}

      {/* notifications — on native, a minimal push row (channel config 403s on a device) */}
      {native ? <NativePushPanel /> : <NotifyPanel />}

      {/* LAN-exposure override + autostart are master-only admin (403 on a device) — desktop only */}
      {!native && <SecurityPanel />}
      {!native && <AutostartPanel />}

      {/* boot checklist */}
      <div className="wl-equip" style={{ position: 'relative', padding: '12px 14px 14px' }}>
        <span className="wl-screw wl-screw--tl" />
        <span className="wl-screw wl-screw--tr" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 4px 10px' }}>
          <span className="wl-sectionlabel">Boot Checklist</span>
          <span className="wl-mono" style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--wl-dim)' }}>
            {env ? `${env.checklist.filter((c) => c.ok).length}/${env.checklist.length} SYSTEMS NOMINAL` : 'PROBING…'}
          </span>
        </div>
        <div style={{ display: 'grid', gap: 6, gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))' }}>
          {env?.checklist.map((c) => (
            <div key={c.key} className="wl-tile" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', minWidth: 0 }}>
              <span className={`wl-led ${c.ok ? 'wl-led--green' : 'wl-led--red'}`} />
              <span className="wl-mono" style={{ fontSize: 12, flex: 'none', color: c.ok ? 'var(--wl-phos-g)' : 'var(--wl-red-hi)', textShadow: c.ok ? '0 0 6px var(--wl-phos-g-glow)' : '0 0 6px rgba(178,86,68,.5)' }}>
                {c.ok ? '✓' : '✗'}
              </span>
              <span className="wl-mono" style={{ fontSize: 11, flex: 'none', color: 'var(--wl-cream)' }}>{c.label}</span>
              <span className="wl-mono" style={{ marginLeft: 'auto', fontSize: 9.5, color: 'var(--wl-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.detail}>
                {c.detail}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* detected on this machine */}
      <div className="wl-equip wl-rust-tr" style={{ position: 'relative', padding: '12px 14px 14px' }}>
        <span className="wl-screw wl-screw--tl" />
        <span className="wl-screw wl-screw--rusty wl-screw--br" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 4px 10px' }}>
          <span className="wl-sectionlabel">{native ? 'Detected On The Desktop' : 'Detected On This Machine'}</span>
          <span className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-phos-g)', textShadow: '0 0 6px var(--wl-phos-g-glow)' }}>
            {installed.length} ONLINE
          </span>
          <div className="wl-divider" style={{ flex: 1 }} />
        </div>
        <div style={{ display: 'grid', gap: 6, gridTemplateColumns: 'repeat(auto-fill,minmax(240px,1fr))' }}>
          {installed.map((a) => (
            <div key={a.key} className="wl-tile" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', minWidth: 0 }}>
              <span className="wl-led wl-led--green" />
              <span style={{ fontSize: 15, flex: 'none', color: 'var(--wl-phos-g)', textShadow: '0 0 8px var(--wl-phos-g-glow)' }}>
                {AGENT_ICON[a.key] ?? '◆'}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="wl-mono" style={{ fontSize: 11, fontWeight: 700, color: 'var(--wl-cream)' }} title={a.blurb}>{a.name}</div>
                <div className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.path ?? ''}>
                  {a.version}
                </div>
              </div>
            </div>
          ))}
        </div>
        {missing.length > 0 && (
          <div style={{ marginTop: 8, display: 'grid', gap: 5, gridTemplateColumns: 'repeat(auto-fill,minmax(240px,1fr))' }}>
            {missing.map((a) => (
              <div key={a.key} className="wl-tile wl-tile--inset" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', opacity: 0.65, minWidth: 0 }} title={a.blurb}>
                <span className="wl-led wl-led--off" />
                <span style={{ fontSize: 13, flex: 'none', color: 'var(--wl-faint)' }}>{AGENT_ICON[a.key] ?? '◆'}</span>
                <span className="wl-mono" style={{ fontSize: 10, color: 'var(--wl-faint)' }}>{a.name}</span>
                <span className="wl-mono" style={{ marginLeft: 'auto', fontSize: 8.5, letterSpacing: 1, color: 'var(--wl-faint)' }}>NOT FOUND</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* external integrations — hidden on native: a phone must not edit integration
          secrets (endpoints/tokens/SSH), and config mutations 403 on a device anyway;
          the connected roster is viewable under Companions instead */}
      {!native && (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="wl-sectionlabel">External Integrations</span>
          <div className="wl-divider" style={{ flex: 1 }} />
        </div>
        <p className="wl-mono" style={{ margin: '5px 0 0', fontSize: 10, color: 'var(--wl-dim)' }}>
          bridge Rezident to other agent systems — endpoints and keys are stored locally; drop a private_slots.json in the data dir for personal slots
        </p>
        {([
          ['oauth', 'ACCOUNT SIGN-IN', 'subscription accounts — connect once via the vendor CLI, no API key'],
          ['api', 'API KEY', 'hosted providers — paste a key, done'],
          ['bridge', 'SELF-HOSTED & BRIDGED', 'your own runtimes — local servers, SSH boxes, private slots'],
        ] as [string, string, string][]).map(([g, label, hint]) => {
          const group = integrations.filter((i) => (g === 'bridge' ? (i.kind === 'bridge' || i.kind === 'local') : i.kind === g))
          if (!group.length) return null
          return (
            <div key={g}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 14 }}>
                <span className="wl-mono" style={{ fontSize: 9, letterSpacing: 2, color: 'var(--wl-phos-g)', textShadow: '0 0 6px var(--wl-phos-g-glow)' }}>{label}</span>
                <span className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-faint)' }}>{hint}</span>
              </div>
              <div style={{ marginTop: 8, display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', alignItems: 'start' }}>
                {group.map((integ) => (
                  <IntegrationCard key={integ.key + String(integ.enabled)} integration={integ} onSaved={() => refresh(false)} />
                ))}
              </div>
            </div>
          )
        })}
      </div>
      )}

      {/* thin identity footer — name · tagline · year, GitHub on the far right */}
      <div className="wl-mono" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', marginTop: 2, borderTop: '1px solid var(--wl-line)', fontSize: 10, color: 'var(--wl-faint)', flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--wl-dim)', letterSpacing: 1.5, fontWeight: 600 }}>REZIDENT</span>
        <span>· self-hosted agent console · © 2026</span>
        <a className="wl-btn wl-btn--steel" href={ghRepo} target="_blank" rel="noreferrer" style={{ ...ghLink, marginLeft: 'auto' }}>GITHUB ↗</a>
      </div>
    </div>
  )
}
