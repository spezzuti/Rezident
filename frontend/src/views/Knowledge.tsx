import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { api, del, get, post } from '../lib/api'
import { lockLabel, useMasterGuard } from '../lib/master'
import { useIsMobile } from '../lib/mobile'

/* one knowledge base = an indexed doc folder (knowledge_bases row) */
interface KnowledgeBase {
  id: string
  name: string
  description: string | null
  source_dir: string
  status: string          // idle | indexing | ready | error
  doc_count: number
  chunk_count: number
  last_indexed_at: string | null
  error: string | null
  created_at: string
}

interface KBConfig {
  provider_key: string
  model: string
  top_k: number
}

/* just the fields the embedder-slot picker needs off /api/integrations */
interface Slot {
  key: string
  name: string
  enabled?: boolean
}

const DEFAULT_CONFIG: KBConfig = { provider_key: 'ollama', model: 'nomic-embed-text', top_k: 5 }

const put = <T = any>(path: string, body: unknown) =>
  api<T>(path, { method: 'PUT', body: JSON.stringify(body) })

/* ---------- shared PIP-OS style fragments (mirrors Memory.tsx) ---------- */

const PANEL_LABEL: CSSProperties = {
  fontSize: 9, fontWeight: 600, letterSpacing: 2, color: '#dfd8c6',
}

const INK_LABEL: CSSProperties = {
  fontSize: 8, fontWeight: 600, letterSpacing: 2, textTransform: 'uppercase', color: '#8fa0b0',
}

/* status → indicator lamp + wording. 'idle' is a never-indexed volume; 'error'
   keeps a recovery path (the RE-INDEX button stays live below). */
const STATUS: Record<string, { label: string; led: string; color: string }> = {
  idle: { label: 'UNINDEXED', led: 'wl-led--off', color: '#8fa0b0' },
  indexing: { label: 'INDEXING', led: 'wl-led--yellow wl-led--blink', color: 'var(--wl-yellow)' },
  ready: { label: 'READY', led: 'wl-led--green', color: 'var(--wl-phos-g)' },
  error: { label: 'FAULT', led: 'wl-led--red wl-led--blink', color: 'var(--wl-red-hi)' },
}

const fmtWhen = (iso: string | null) => {
  if (!iso) return 'never'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? 'never' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/* ---------- one archive volume ---------- */

function VolumeCard({ kb, onChanged }: { kb: KnowledgeBase; onChanged: () => void }) {
  const st = STATUS[kb.status] ?? STATUS.idle
  const busy = kb.status === 'indexing'
  const { locked, guard } = useMasterGuard() // re-index + delete are master-only

  return (
    <div className="wl-tile" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      {/* header: reel glyph + name + status lamp */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <span style={{
          flex: 'none', width: 30, height: 30, borderRadius: '50%',
          background: 'repeating-conic-gradient(from 12deg,#39424c 0 14deg,rgba(10,15,20,0) 14deg 60deg),radial-gradient(circle,#0d1216 26%,#232c35 28%,#161d24 100%)',
          border: '2px solid #39424c', boxShadow: 'inset 0 1px 2px rgba(0,0,0,.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, color: 'var(--wl-phos-g)', textShadow: '0 0 6px var(--wl-phos-g-glow)',
        }}>❋</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="wl-mono" style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: 0.5, color: 'var(--wl-cream)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {kb.name || 'UNNAMED VOLUME'}
          </div>
          {kb.description && (
            <div className="wl-mono" style={{ fontSize: 9, color: '#8fa0b0', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {kb.description}
            </div>
          )}
        </div>
        <span className="wl-mono" style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 8.5, letterSpacing: 1.5, color: st.color }}>
          <span className={`wl-led ${st.led}`} />
          {st.label}
        </span>
      </div>

      {/* source path readout */}
      <div style={{
        background: 'linear-gradient(180deg,#10151a,#1c242c)', borderRadius: 3, border: '1px solid #0a0f14',
        padding: '5px 9px', boxShadow: 'inset 0 2px 4px rgba(0,0,0,.7)',
      }}>
        <div style={INK_LABEL}>Source Corpus</div>
        <div className="wl-mono" style={{ fontSize: 10, color: '#aebccb', marginTop: 2, wordBreak: 'break-all', lineHeight: 1.4 }}>
          {kb.source_dir}
        </div>
      </div>

      {/* index stats */}
      <div className="wl-mono" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 9, color: '#8fa0b0' }}>
        <span><span style={{ color: 'var(--wl-cream)' }}>{kb.doc_count}</span> DOCS</span>
        <span><span style={{ color: 'var(--wl-cream)' }}>{kb.chunk_count}</span> CHUNKS</span>
        <span style={{ marginLeft: 'auto' }}>INDEXED · {fmtWhen(kb.last_indexed_at).toUpperCase()}</span>
      </div>

      {kb.status === 'error' && kb.error && (
        <div className="wl-mono" style={{ fontSize: 9.5, color: 'var(--wl-red-hi)', lineHeight: 1.5, background: 'rgba(200,60,50,.08)', border: '1px solid rgba(200,60,50,.3)', borderRadius: 3, padding: '5px 8px', wordBreak: 'break-word' }}>
          ✕ {kb.error}
        </div>
      )}

      {/* controls: RE-INDEX (poll) + delete */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, borderTop: '1px solid var(--wl-line)', paddingTop: 9 }}>
        <button
          type="button"
          className="wl-btn wl-btn--steel"
          disabled={busy}
          style={{ fontSize: 9.5, padding: '5px 12px', ...(busy ? { opacity: 0.5, cursor: 'default' } : { opacity: locked ? 0.55 : 1 }) }}
          title={busy ? 'an index run is already underway' : 'walk the source folder and rebuild the vector index'}
          onClick={guard(async () => { try { await post(`/api/knowledge/${kb.id}/index`) } catch { /* already indexing */ } onChanged() })}
        >
          {busy ? '◌ INDEXING…' : lockLabel(locked, kb.status === 'idle' ? '⟳ INDEX NOW' : '⟳ RE-INDEX')}
        </button>
        <button
          type="button"
          className="wl-mono"
          style={{ marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 9, letterSpacing: 1, color: '#5d6e7e', whiteSpace: 'nowrap', opacity: locked ? 0.55 : 1 }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--wl-red-hi)' }}
          onMouseLeave={(e) => { e.currentTarget.style.color = '#5d6e7e' }}
          onClick={guard(async () => {
            if (window.confirm(`Purge "${kb.name}"? Its index (${kb.chunk_count} chunks) is deleted — your source folder is left untouched.`)) {
              await del(`/api/knowledge/${kb.id}`)
              onChanged()
            }
          })}
        >
          {lockLabel(locked, '✕ PURGE')}
        </button>
      </div>
    </div>
  )
}

/* ---------- Knowledge archive screen ---------- */

export default function Knowledge() {
  const mobile = useIsMobile()
  const [bases, setBases] = useState<KnowledgeBase[]>([])
  const [slots, setSlots] = useState<Slot[]>([])
  const [config, setConfig] = useState<KBConfig>(DEFAULT_CONFIG)
  const [cfgDirty, setCfgDirty] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDir, setNewDir] = useState('')
  const [browsing, setBrowsing] = useState(false)
  const { locked, guard } = useMasterGuard() // create + config save are master-only

  const refresh = useCallback(() => {
    get<KnowledgeBase[]>('/api/knowledge').then(setBases).catch(() => {})
  }, [])

  useEffect(refresh, [refresh])

  // config + embedder-slot roster (degrade quietly if either endpoint is absent)
  useEffect(() => {
    get<KBConfig>('/api/knowledge/config').then((c) => setConfig({ ...DEFAULT_CONFIG, ...c })).catch(() => {})
    get<Slot[]>('/api/integrations').then(setSlots).catch(() => {})
  }, [])

  // while any volume is indexing, poll the roster like the memory-import banner
  const indexing = bases.some((b) => b.status === 'indexing')
  useEffect(() => {
    if (!indexing) return
    const t = setInterval(refresh, 3000)
    return () => clearInterval(t)
  }, [indexing, refresh])

  const setCfg = (upd: Partial<KBConfig>) => { setConfig((c) => ({ ...c, ...upd })); setCfgDirty(true) }

  async function saveConfig() {
    const saved = await put<KBConfig>('/api/knowledge/config', config)
    setConfig({ ...DEFAULT_CONFIG, ...saved })
    setCfgDirty(false)
  }

  async function createBase() {
    if (!newName.trim() || !newDir.trim()) return
    await post('/api/knowledge', { name: newName.trim(), source_dir: newDir.trim() })
    setNewName('')
    setNewDir('')
    refresh()
  }

  // Pop the OS folder picker ON THE SERVER machine (the corpus lives there). No-op if
  // the picker can't be shown — e.g. a remote/phone session; then just type the path.
  async function browse() {
    if (browsing) return           // single-flight: don't stack dialogs on rapid clicks
    setBrowsing(true)
    try {
      const r = await post<{ path?: string | null; busy?: boolean }>('/api/system/pick-folder')
      if (r && r.path) setNewDir(r.path)
    } catch {
      /* picker unavailable — fall back to typing the path */
    } finally {
      setBrowsing(false)
    }
  }

  // the slot picker always offers the current provider even if it isn't in the roster
  const slotOptions = Array.from(new Set([config.provider_key, ...slots.map((s) => s.key)].filter(Boolean)))
  const slotLabel = (key: string) => slots.find((s) => s.key === key)?.name ?? key
  const ready = bases.filter((b) => b.status === 'ready').length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}>

      {/* ===== INDEXER header strip ===== */}
      <div className="wl-equip" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <span className="wl-screw wl-screw--tl" /><span className="wl-screw wl-screw--br" />
        <span style={PANEL_LABEL}>KNOWLEDGE ARCHIVE</span>
        <div style={{
          flex: 1, minWidth: 120, height: 14, borderRadius: 3,
          background: 'linear-gradient(180deg,#0c1116,#1a222a)',
          boxShadow: 'inset 0 3px 6px rgba(0,0,0,.8),0 1px 0 rgba(255,255,255,.06)', position: 'relative', overflow: 'hidden',
        }}>
          <span style={{ position: 'absolute', left: 12, right: 12, top: 5, height: 4, background: 'repeating-linear-gradient(90deg,rgba(63,143,94,.6) 0 6px,rgba(63,143,94,0) 6px 12px)', borderRadius: 2 }} />
        </div>
        <span className={`wl-led ${indexing ? 'wl-led--yellow wl-led--blink' : 'wl-led--green'}`} />
        <span className="wl-mono" style={{ fontSize: 9, letterSpacing: 1, color: '#8fa0b0' }}>
          {bases.length} VOLUME{bases.length === 1 ? '' : 'S'} · {ready} READY
        </span>
      </div>

      {/* ===== EMBEDDER CORE config row ===== */}
      <div className="wl-equip wl-rust-tr" style={{ padding: '12px 16px', display: 'flex', alignItems: 'flex-end', gap: 14, flexWrap: 'wrap' }}>
        <span className="wl-screw wl-screw--tl" /><span className="wl-screw wl-screw--rusty wl-screw--tr" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 'none' }}>
          <span style={PANEL_LABEL}>EMBEDDER CORE</span>
          <span className="wl-mono" style={{ fontSize: 8.5, color: '#5d6e7e', letterSpacing: 1 }}>vector engine for every volume</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={INK_LABEL}>Provider Slot</div>
          <select
            className="wl-input"
            style={{ padding: '5px 8px', minWidth: 150 }}
            value={config.provider_key}
            onChange={(e) => setCfg({ provider_key: e.target.value })}
          >
            {slotOptions.map((key) => (
              <option key={key} value={key}>{slotLabel(key).toUpperCase()}</option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 160 }}>
          <div style={INK_LABEL}>Embedding Model</div>
          <input
            className="wl-input"
            style={{ width: '100%' }}
            placeholder="nomic-embed-text"
            value={config.model}
            onChange={(e) => setCfg({ model: e.target.value })}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 'none' }}>
          <div style={INK_LABEL}>Top-K</div>
          <input
            type="number"
            min={1}
            className="wl-input"
            style={{ width: 72 }}
            value={config.top_k}
            onChange={(e) => setCfg({ top_k: Math.max(1, Number(e.target.value) || 1) })}
          />
        </div>
        <div className="wl-btn-housing" style={{ flex: 'none' }}>
          <button
            className="wl-btn"
            disabled={!cfgDirty}
            style={!cfgDirty ? { opacity: 0.5, cursor: 'default' } : { opacity: locked ? 0.55 : 1 }}
            onClick={guard(saveConfig)}
          >
            {lockLabel(locked, 'SET CORE')}
          </button>
        </div>
      </div>

      {/* ===== commission a new volume ===== */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          className="wl-input"
          style={{ flex: '1 1 180px', minWidth: 0 }}
          placeholder="volume name — e.g. 'Project Docs'"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && guard(createBase)()}
        />
        <input
          className="wl-input"
          style={{ flex: '2 1 260px', minWidth: 0 }}
          placeholder="source folder — e.g. C:\Users\sleve\src\project\docs"
          value={newDir}
          onChange={(e) => setNewDir(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && guard(createBase)()}
        />
        <button
          type="button"
          className="wl-btn wl-btn--steel"
          disabled={browsing}
          style={{ flex: 'none', fontSize: 10, padding: '6px 13px', ...(browsing ? { opacity: 0.6, cursor: 'default' } : undefined) }}
          title="pick a folder on this machine"
          onClick={browse}
        >
          {browsing ? '◌ OPENING…' : '▸ BROWSE…'}
        </button>
        <div className="wl-btn-housing">
          <button
            className="wl-btn"
            disabled={!newName.trim() || !newDir.trim()}
            style={!newName.trim() || !newDir.trim() ? { opacity: 0.5, cursor: 'default' } : { opacity: locked ? 0.55 : 1 }}
            onClick={guard(createBase)}
          >
            {lockLabel(locked, '+ COMMISSION VOLUME')}
          </button>
        </div>
      </div>

      {/* ===== the archive shelf ===== */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={PANEL_LABEL}>ARCHIVE SHELF · {bases.length} VOLUME{bases.length === 1 ? '' : 'S'}</span>
        <div className="wl-divider" style={{ flex: 1 }} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: mobile ? 'minmax(0,1fr)' : 'repeat(2,minmax(0,1fr))', gap: 12, alignItems: 'start' }}>
        {bases.map((kb) => (
          <VolumeCard key={kb.id} kb={kb} onChanged={refresh} />
        ))}
      </div>

      {bases.length === 0 && (
        <div className="wl-tile--inset wl-mono" style={{ borderRadius: 4, padding: '22px 14px', textAlign: 'center', fontSize: 10.5, color: '#5d6e7e', lineHeight: 1.6 }}>
          shelf empty — no archive volumes yet. name a volume and point it at a docs folder above,
          then ⟳ INDEX NOW to embed it. attach a volume to a companion in COMPANIONS so it can retrieve from it.
        </div>
      )}
    </div>
  )
}
