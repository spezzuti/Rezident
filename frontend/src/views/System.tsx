import { useCallback, useEffect, useState } from 'react'
import { api, get, post } from '../lib/api'
import { CRT_SKINS, getCrtSkin, setCrtSkin } from '../lib/theme'
import { getSoundOn, setSoundOn, sfx } from '../lib/sound'
import { getNotifyPrefs, setNotifySound, requestNotifyPermission, testChime } from '../lib/notify'

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

const TRANSPORT_LABEL: Record<string, string> = { openai: 'HTTP API', 'hermes-cli': 'CLI · SSH', acp: 'ACP · SSH', 'codex-cli': 'CODEX · LOCAL', 'gemini-cli': 'GEMINI · LOCAL', 'qwen-cli': 'QWEN · LOCAL' }

/* local OAuth-CLI transports: the vendor CLI holds the sign-in; no key stored here */
const LOCAL_CLI: Record<string, { bin: string; account: string; login: string; modelPh: string }> = {
  'codex-cli': { bin: 'codex', account: 'ChatGPT account', login: 'codex login', modelPh: 'model (optional) — gpt-5-codex · blank = the CLI\'s default' },
  'gemini-cli': { bin: 'gemini', account: 'Google account (Code Assist license — no free tier; else use an AI Studio key on HTTP API)', login: 'gemini (first run signs in)', modelPh: 'model (optional) — gemini-2.5-pro · blank = the CLI\'s default' },
  'qwen-cli': { bin: 'qwen', account: 'qwen.ai Coding Plan (paid — else use a DashScope key on HTTP API)', login: 'qwen then /auth (first run signs in)', modelPh: 'model (optional) — blank = the CLI\'s default' },
}

function IntegrationCard({ integration, onSaved }: { integration: Integration; onSaved: () => void }) {
  const [cfg, setCfg] = useState({ enabled: integration.enabled, endpoint: integration.endpoint ?? '', token: '', model: integration.model ?? '', ssh: integration.ssh ?? '', notes: integration.notes ?? '', transport: integration.transport ?? 'openai' })
  const isCli = cfg.transport === 'hermes-cli'
  const isAcp = cfg.transport === 'acp'
  const isSsh = isCli || isAcp  // both talk over SSH and need only the ssh destination
  const localCli = LOCAL_CLI[cfg.transport]  // local OAuth CLI (codex/gemini/qwen) — nothing required here
  // TEST/SEND become available once the saved config is usable for its transport
  const configured = localCli ? true : isSsh ? !!integration.ssh : !!integration.endpoint
  // enabled cards mount collapsed to a summary line; the chevron (or name) expands
  const [open, setOpen] = useState(!integration.enabled)
  const [dirty, setDirty] = useState(false)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null)
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

  // live result if just tested, else the last stored probe status
  const status = result
    ? { ok: result.ok, text: (result.ok ? '● REACHABLE' : '✗ UNREACHABLE') + (result.detail ? ' · ' + result.detail : '') }
    : integration.last_status
      ? { ok: integration.last_status === 'reachable', text: (integration.last_status === 'reachable' ? '● reachable' : '✗ unreachable') + (integration.last_detail ? ' · ' + integration.last_detail : '') }
      : null

  // collapsed = enabled card folded to its summary line; unsaved edits force it open
  const expanded = cfg.enabled && (open || dirty)
  const summary = `${TRANSPORT_LABEL[cfg.transport] ?? cfg.transport} · ${(localCli ? cfg.model || `${localCli.account} sign-in` : isSsh ? cfg.ssh : cfg.endpoint) || 'not configured'}`

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
          {/* transport: how Rezident talks to this runtime — label ABOVE so the
              select spans the card like every other row (an inline label used to
              push the select past the card edge: selects don't shrink below
              their longest option without minWidth:0) */}
          <div className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-faint)', letterSpacing: 1.5 }}>LINK</div>
          <select className="wl-input" style={{ width: '100%', minWidth: 0, padding: '5px 8px' }}
                  value={cfg.transport} onChange={(e) => set({ transport: e.target.value })}>
            <option value="openai">OpenAI HTTP API (/v1/chat/completions)</option>
            <option value="codex-cli">Codex CLI — ChatGPT sign-in (local)</option>
            <option value="gemini-cli">Gemini CLI — Google sign-in (local)</option>
            <option value="qwen-cli">Qwen CLI — qwen.ai sign-in (local)</option>
            <option value="hermes-cli">Hermes CLI over SSH (hermes -z)</option>
            <option value="acp">Hermes ACP over SSH (streaming · tools)</option>
          </select>
          {localCli ? (
            <>
              <input className="wl-input" style={{ width: '100%' }}
                     placeholder={localCli.modelPh}
                     value={cfg.model} onChange={(e) => set({ model: e.target.value })} />
              <input className="wl-input" style={{ width: '100%' }}
                     placeholder={`${localCli.bin} binary (optional) — blank = auto-detect on PATH`}
                     value={cfg.endpoint} onChange={(e) => set({ endpoint: e.target.value })} />
              <div className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-dim)', lineHeight: 1.5, padding: '0 2px' }}>
                Runs the local <code>{localCli.bin}</code> CLI signed in with your <b>{localCli.account}</b> — {localCli.login} once in a terminal.
                No API key is stored here; the sign-in lives with the CLI.
              </div>
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
          ) : (
            <>
              <input className="wl-input" style={{ width: '100%' }}
                     placeholder="endpoint — e.g. http://127.0.0.1:8642 (OpenAI-compatible base URL)"
                     value={cfg.endpoint} onChange={(e) => set({ endpoint: e.target.value })} />
              <input className="wl-input" style={{ width: '100%' }}
                     placeholder="model — gpt-4o · openai/gpt-4o · hermes-4 (blank = default)"
                     value={cfg.model} onChange={(e) => set({ model: e.target.value })} />
              <input className="wl-input" style={{ width: '100%' }}
                     type="password"
                     placeholder={integration.has_token ? 'token — saved (type to replace)' : 'token / api key'}
                     value={cfg.token} onChange={(e) => set({ token: e.target.value })} />
              <input className="wl-input" style={{ width: '100%' }}
                     placeholder="ssh (optional) — user@host[:port] to tunnel to a remote runtime"
                     value={cfg.ssh} onChange={(e) => set({ ssh: e.target.value })} />
            </>
          )}
          <input className="wl-input" style={{ width: '100%' }}
                 placeholder="notes" value={cfg.notes} onChange={(e) => set({ notes: e.target.value })} />
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
  const permLabel = prefs.permission === 'granted' ? '● desktop alerts ON'
    : prefs.permission === 'denied' ? '✕ blocked (unblock in browser)'
    : prefs.permission === 'unsupported' ? '— unsupported here' : '○ enable desktop alerts'
  return (
    <div className="wl-equip" style={{ position: 'relative', padding: '12px 14px 14px' }}>
      <span className="wl-screw wl-screw--tl" />
      <span className="wl-screw wl-screw--tr" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 4px 10px' }}>
        <span className="wl-sectionlabel">Notifications</span>
        <span className="wl-mono" style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--wl-dim)' }}>PING ME WHEN A TASK NEEDS ME</span>
      </div>
      <div className="wl-tile" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', flexWrap: 'wrap', marginBottom: 8 }}>
        <span className="wl-mono" style={{ fontSize: 12, color: 'var(--wl-dim)' }}>THIS DEVICE</span>
        <button type="button" className="wl-btn wl-btn--steel" style={{ padding: '5px 12px', fontSize: 11 }} onClick={enableBrowser}>{permLabel}</button>
        <Toggle on={prefs.sound} onClick={() => { setNotifySound(!prefs.sound); setPrefs(getNotifyPrefs()) }} title="chime" />
        <span className="wl-mono" style={{ fontSize: 11, color: 'var(--wl-dim)' }}>chime</span>
        <button type="button" className="wl-btn wl-btn--steel" style={{ padding: '5px 10px', fontSize: 10 }} onClick={() => testChime()}>♪ test</button>
      </div>
      <div className="wl-tile" style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
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
                style={{ padding: '5px 12px', fontSize: 10, ...(host === v ? { boxShadow: 'inset 0 0 0 1px var(--wl-phos-g)', color: 'var(--wl-phos-g)' } : {}) }}
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

export default function System() {
  const [env, setEnv] = useState<Environment | null>(null)
  const [integrations, setIntegrations] = useState<Integration[]>([])
  const [scanning, setScanning] = useState(false)
  const [crtSkin, setCrt] = useState(getCrtSkin())
  const [sndOn, setSnd] = useState(getSoundOn())

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

  return (
    <div className="min-h-full p-4 md:p-6" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* workshop header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div className="wl-sectionlabel">System · Setup</div>
          <div className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-faint)', marginTop: 3 }}>
            AGENTOS v{env?.agentos_version ?? '…'} · CLAUDE-AGENT-SDK {env?.sdk_version ?? '…'}
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
        <div className="wl-tile" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', flexWrap: 'wrap' }}>
          <span className="wl-mono" style={{ fontSize: 12, color: 'var(--wl-dim)' }}>CRT PHOSPHOR</span>
          <div style={{ display: 'flex', gap: 6 }}>
            {CRT_SKINS.map((s) => {
              const on = crtSkin === s.value
              return (
                <button
                  key={s.value || 'green'}
                  type="button"
                  className="wl-btn wl-btn--steel"
                  style={{ padding: '5px 14px', fontSize: 11, ...(on ? { boxShadow: 'inset 0 0 0 1px var(--wl-phos-g)', color: 'var(--wl-phos-g)', textShadow: '0 0 6px var(--wl-phos-g-glow)' } : {}) }}
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
        <div className="wl-tile" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', flexWrap: 'wrap', marginTop: 8 }}>
          <span className="wl-mono" style={{ fontSize: 12, color: 'var(--wl-dim)' }}>UI SOUND</span>
          <div style={{ display: 'flex', gap: 6 }}>
            {([true, false] as const).map((v) => {
              const on = sndOn === v
              return (
                <button
                  key={String(v)}
                  type="button"
                  className="wl-btn wl-btn--steel"
                  style={{ padding: '5px 14px', fontSize: 11, ...(on ? { boxShadow: 'inset 0 0 0 1px var(--wl-phos-g)', color: 'var(--wl-phos-g)', textShadow: '0 0 6px var(--wl-phos-g-glow)' } : {}) }}
                  onClick={() => { setSoundOn(v); setSnd(v); if (v) sfx.confirm() }}
                >
                  {on ? '● ' : '○ '}{v ? 'ON' : 'OFF'}
                </button>
              )
            })}
          </div>
          <span className="wl-mono" style={{ fontSize: 9, color: 'var(--wl-faint)', marginLeft: 'auto' }}>
            relay clicks · boot audio · task verdict chimes — the notify chime has its own switch below
          </span>
        </div>
      </div>

      {/* notifications */}
      <NotifyPanel />

      {/* opt-in boot-level autostart */}
      <AutostartPanel />

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
          <span className="wl-sectionlabel">Detected On This Machine</span>
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

      {/* external integrations */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="wl-sectionlabel">External Integrations</span>
          <div className="wl-divider" style={{ flex: 1 }} />
        </div>
        <p className="wl-mono" style={{ margin: '5px 0 0', fontSize: 10, color: 'var(--wl-dim)' }}>
          bridge Rezident to other agent systems — endpoints and keys are stored locally; drop a private_slots.json in the data dir for personal slots
        </p>
        <div style={{ marginTop: 10, display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', alignItems: 'start' }}>
          {integrations.map((integ) => (
            <IntegrationCard key={integ.key + String(integ.enabled)} integration={integ} onSaved={() => refresh(false)} />
          ))}
        </div>
      </div>

    </div>
  )
}
