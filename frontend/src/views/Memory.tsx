import { useCallback, useEffect, useRef, useState } from 'react'
import { useIsMobile } from '../lib/mobile'
import type { CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { del, get, post, api } from '../lib/api'
import { lockLabel, useMasterGuard } from '../lib/master'
import MemoryGraph from '../components/MemoryGraph'

interface Fact {
  id: string
  content: string
  tags: string
  source: string
  agent_key: string | null
  enabled: number
  updated_at: string
}

/* owner chip data resolved from the /api/agents roster */
interface Owner {
  name: string
  icon: string
  color: string
}

interface Episode {
  id: string
  task_id: string
  title: string
  summary: string | null
  outcome: string
  cost_usd: number
  created_at: string
}

const patch = (path: string, body: unknown) =>
  api(path, { method: 'PATCH', body: JSON.stringify(body) })

/* ---------- shared PIP-OS style fragments ---------- */

const PANEL_LABEL: CSSProperties = {
  fontSize: 9, fontWeight: 600, letterSpacing: 2, color: '#dfd8c6',
}

const rivet = (pos: CSSProperties): CSSProperties => ({
  position: 'absolute', width: 4, height: 4, borderRadius: '50%',
  background: 'radial-gradient(circle at 35% 30%,#8a6a30,#3a2a10)',
  boxShadow: 'inset 0 -0.5px 1px rgba(0,0,0,.6)',
  ...pos,
})

const reel = (from: number): CSSProperties => ({
  position: 'relative', width: 24, height: 24, borderRadius: '50%',
  background: `repeating-conic-gradient(from ${from}deg,#39424c 0 14deg,rgba(10,15,20,0) 14deg 60deg),radial-gradient(circle,#0d1216 28%,#232c35 30%,#161d24 100%)`,
  border: '2px solid #39424c',
  boxShadow: 'inset 0 1px 2px rgba(0,0,0,.7),0 0 2px rgba(0,0,0,.5)',
})

const reelHub: CSSProperties = {
  position: 'absolute', left: '50%', top: '50%', width: 6, height: 6, borderRadius: '50%',
  background: '#0a0f14', transform: 'translate(-50%,-50%)', border: '1px solid #39424c',
}

const labelStrip: CSSProperties = {
  marginTop: 8,
  background: 'linear-gradient(165deg,#f4ecd0,#e2d6ae)',
  borderRadius: 2, padding: '3px 8px',
  fontFamily: "'Caveat', cursive", fontWeight: 600, fontSize: 13.5, color: '#4a4230',
  boxShadow: '0 1px 2px rgba(0,0,0,.25),inset 0 1px 1px rgba(255,255,255,.5)',
}

const knobMark: CSSProperties = {
  height: 4, width: 1.5, top: 0, transformOrigin: '50% 5px',
}

/* each knob click advances 30° — full 360° sweep, wrapping */
const nextRotStep = (v: number): number => (v + 30) % 360

/* ---------- holotape cassette (one fact) ---------- */

function HolotapeCard({ fact, owner, highlighted, onChanged }: {
  fact: Fact
  owner: Owner | null
  highlighted: boolean
  onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(fact.content)
  const { locked, guard } = useMasterGuard() // fact edit/toggle/delete are master-only

  async function save() {
    if (text.trim() && text !== fact.content) {
      await patch(`/api/memory/facts/${fact.id}`, { content: text.trim() })
    }
    setEditing(false)
    onChanged()
  }

  return (
    <div
      className="wl-tile"
      style={{
        padding: 10, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0,
        opacity: fact.enabled ? 1 : 0.55,
        outline: highlighted ? '2px solid var(--wl-yellow)' : undefined,
        boxShadow: highlighted ? '0 0 18px rgba(232,193,74,.45)' : undefined,
      }}
    >
      {/* amber plastic cassette body, clipped corner */}
      <div style={{
        position: 'relative',
        backgroundImage: 'radial-gradient(ellipse 30px 12px at 8% 100%,rgba(50,26,12,.25),transparent 70%),linear-gradient(115deg,rgba(255,255,255,.18),rgba(255,255,255,0) 42%),linear-gradient(180deg,#c8923c 0%,#b07c2c 55%,#95651f 100%)',
        border: '1px solid #10151a', borderRadius: 4, padding: '9px 10px 8px',
        boxShadow: '0 4px 8px rgba(0,0,0,.5),0 1px 2px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.35),inset 0 -3px 4px rgba(0,0,0,.35),inset -2px 0 3px rgba(0,0,0,.15)',
        clipPath: 'polygon(0 0,calc(100% - 16px) 0,100% 16px,100% 100%,0 100%)',
      }}>
        <span style={rivet({ top: 3, left: 3 })} />
        <span style={rivet({ bottom: 3, left: 3 })} />
        <span style={rivet({ bottom: 3, right: 3 })} />

        {/* dark window with two reels + tape bar */}
        <div style={{
          position: 'relative', background: 'linear-gradient(180deg,#10151a,#1c242c)',
          borderRadius: 4, border: '1px solid #0a0f14', padding: '6px 10px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          boxShadow: 'inset 0 2px 5px rgba(0,0,0,.8),0 1px 0 rgba(255,255,255,.15)', overflow: 'hidden',
        }}>
          <div style={{
            position: 'absolute', left: 14, right: 14, top: '50%', height: 9, transform: 'translateY(-50%)',
            background: 'linear-gradient(180deg,#1a1108,#2c1d0c 50%,#1a1108)', borderRadius: 2,
          }} />
          <div style={reel(12)}><span style={reelHub} /></div>
          <div style={reel(40)}><span style={reelHub} /></div>
          <div style={{
            position: 'absolute', inset: 0, pointerEvents: 'none',
            background: 'linear-gradient(120deg,rgba(255,255,255,.13),rgba(255,255,255,0) 45%)',
          }} />
        </div>

        {/* handwritten label strip — click to edit */}
        {editing ? (
          <textarea
            autoFocus
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && save()}
            style={{
              ...labelStrip, display: 'block', width: '100%', resize: 'none',
              border: '1px solid #8a6a14', outline: 'none', lineHeight: 1.25,
            }}
          />
        ) : (
          <div
            title={fact.content}
            onClick={guard(() => setEditing(true))}
            style={{
              ...labelStrip, transform: 'rotate(-.6deg)', cursor: 'text',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}
          >
            {fact.content}
          </div>
        )}

        {/* tape bar + microprint */}
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            flex: 1, height: 9, borderRadius: 2,
            background: 'repeating-linear-gradient(90deg,rgba(0,0,0,.35) 0 3px,rgba(255,255,255,.06) 3px 4px,transparent 4px 7px)',
            boxShadow: 'inset 0 1px 1px rgba(0,0,0,.3)',
          }} />
          <span className="wl-mono" style={{ fontSize: 6.5, letterSpacing: 1, color: 'rgba(30,18,4,.65)' }}>HOLOTAPE</span>
        </div>
      </div>

      {/* controls row: power LED toggle · tags · eject */}
      <div className="wl-mono" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 9, color: '#5d6e7e', minWidth: 0 }}>
        <button
          title={fact.enabled ? 'disable (stops injecting into agents)' : 'enable'}
          onClick={guard(async () => {
            await patch(`/api/memory/facts/${fact.id}`, { enabled: !fact.enabled })
            onChanged()
          })}
          style={{
            display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: 'none',
            padding: 0, cursor: 'pointer', color: 'inherit', font: 'inherit', letterSpacing: 1,
            opacity: locked ? 0.55 : 1,
          }}
        >
          <span className={`wl-led ${fact.enabled ? 'wl-led--green' : 'wl-led--off'}`} />
          {lockLabel(locked, fact.enabled ? 'LIVE' : 'OFF')}
        </button>
        {owner && (
          <span
            title={`recorded by ${owner.name}`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0,
              border: `1px solid ${owner.color}`, borderRadius: 2, padding: '0 5px',
              color: owner.color, letterSpacing: 1, whiteSpace: 'nowrap',
            }}
          >
            {owner.icon} {owner.name.toUpperCase()}
          </span>
        )}
        {fact.tags && (
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {fact.tags}
          </span>
        )}
        <button
          title="eject / delete"
          onClick={guard(async () => {
            await del(`/api/memory/facts/${fact.id}`)
            onChanged()
          })}
          style={{
            marginLeft: 'auto', background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            color: '#5d6e7e', font: 'inherit', letterSpacing: 1, whiteSpace: 'nowrap',
            opacity: locked ? 0.55 : 1,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--wl-red-hi)' }}
          onMouseLeave={(e) => { e.currentTarget.style.color = '#5d6e7e' }}
        >
          {lockLabel(locked, '✕ EJECT')}
        </button>
      </div>
    </div>
  )
}

/* ---------- Holotapes screen ---------- */

interface ImportState {
  status: 'idle' | 'scanning' | 'ready' | 'failed' | 'applied' | 'dismissed'
  proposals: string[]
  error?: string | null
}

export default function Memory() {
  const mobile = useIsMobile()
  const [facts, setFacts] = useState<Fact[]>([])
  const [episodes, setEpisodes] = useState<Episode[]>([])
  const [owners, setOwners] = useState<Record<string, Owner>>({})
  const [imp, setImp] = useState<ImportState>({ status: 'idle', proposals: [] })
  const [impSel, setImpSel] = useState<Set<number>>(new Set())
  const [q, setQ] = useState('')
  const [newFact, setNewFact] = useState('')
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const [rot, setRot] = useState({ x: 0, y: 0 })
  const factRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const { locked, guard } = useMasterGuard() // add-fact + archive import are master-only

  const selectFromGraph = useCallback((id: string) => {
    setHighlightId(id)
    factRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setTimeout(() => setHighlightId(null), 2500)
  }, [])

  const refresh = useCallback(() => {
    const suffix = q ? `?q=${encodeURIComponent(q)}` : ''
    get<Fact[]>(`/api/memory/facts${suffix}`).then(setFacts)
    get<Episode[]>(`/api/memory/episodes${suffix}`).then(setEpisodes)
  }, [q])

  useEffect(() => {
    const t = setTimeout(refresh, 200)
    return () => clearTimeout(t)
  }, [refresh])

  useEffect(() => {
    // roster → owner chips: agent facts key on 'profile:<id>' / 'integration:<key>'
    get<any[]>('/api/agents').then((list) => {
      const map: Record<string, Owner> = {}
      for (const a of list) {
        const owner = { name: a.name, icon: a.icon || '◆', color: a.color || '#8fa0b0' }
        if (a.profile_id) map[`profile:${a.profile_id}`] = owner
        if (a.integration_key) map[`integration:${a.integration_key}`] = owner
      }
      setOwners(map)
    }).catch(() => {})
  }, [])

  async function addFact() {
    if (!newFact.trim()) return
    await post('/api/memory/facts', { content: newFact.trim() })
    setNewFact('')
    refresh()
  }

  /* ---- curated import of local Claude archives ---- */
  const syncImport = useCallback((s: ImportState) => {
    setImp(s)
    if (s.status === 'ready') setImpSel(new Set(s.proposals.map((_, i) => i)))
  }, [])

  useEffect(() => {
    get<ImportState>('/api/memory/import/status').then(syncImport).catch(() => {})
  }, [syncImport])

  useEffect(() => {
    if (imp.status !== 'scanning') return
    const t = setInterval(() => {
      get<ImportState>('/api/memory/import/status').then(syncImport).catch(() => {})
    }, 3000)
    return () => clearInterval(t)
  }, [imp.status, syncImport])

  async function startScan() {
    try { syncImport(await post<ImportState>('/api/memory/import/scan')) } catch { /* already scanning */ }
  }

  async function applyImport() {
    const picked = imp.proposals.filter((_, i) => impSel.has(i))
    if (!picked.length) return
    await post('/api/memory/import/apply', { facts: picked })
    setImp({ status: 'applied', proposals: [] })
    refresh()
  }

  async function dismissImport() {
    await post('/api/memory/import/dismiss')
    setImp({ status: 'dismissed', proposals: [] })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}>

      {/* ===== TAPE READER strip ===== */}
      <div className="wl-equip" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <span className="wl-screw wl-screw--tl" /><span className="wl-screw wl-screw--br" />
        <span style={PANEL_LABEL}>TAPE READER</span>
        <div style={{
          flex: 1, height: 14, borderRadius: 3,
          background: 'linear-gradient(180deg,#0c1116,#1a222a)',
          boxShadow: 'inset 0 3px 6px rgba(0,0,0,.8),0 1px 0 rgba(255,255,255,.06)', position: 'relative',
        }}>
          <span style={{ position: 'absolute', left: 12, right: 12, top: 5, height: 4, background: '#04070a', borderRadius: 2 }} />
        </div>
        <span className="wl-led wl-led--yellow wl-led--blink" />
        <span className="wl-microlabel">INSERT TAPE</span>
        <input
          className="wl-input"
          style={{ width: 'min(300px, 34vw)' }}
          placeholder="⌕ scan the archive…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {/* ===== first-run archive banner — shown only while the scan state is virgin ===== */}
      {imp.status === 'idle' && (
        <div className="wl-equip" style={{ position: 'relative', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', borderLeft: '3px solid var(--wl-yellow)' }}>
          <span className="wl-screw wl-screw--tl" /><span className="wl-screw wl-screw--br" />
          <span style={{ fontSize: 22, color: 'var(--wl-yellow)', textShadow: '0 0 10px rgba(232,193,74,.5)', flex: 'none' }}>⌬</span>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: 2, color: '#dfd8c6' }}>LOCAL ARCHIVES DETECTED — RACK NOT SEEDED</div>
            <div className="wl-mono" style={{ fontSize: 9.5, color: '#8fa0b0', marginTop: 3, lineHeight: 1.5 }}>
              this machine already holds Claude memory (~/.claude). scan it to distill proposed holotapes —
              you approve every tape before it reaches the rack; the originals are never touched.
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 'none' }}>
            <div className="wl-btn-housing">
              <button className="wl-btn" style={{ opacity: locked ? 0.55 : 1 }} onClick={guard(startScan)}>{lockLabel(locked, '⌬ SCAN LOCAL ARCHIVES')}</button>
            </div>
            <button
              type="button"
              className="wl-mono"
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 9, letterSpacing: 1, color: '#5d6e7e', opacity: locked ? 0.55 : 1 }}
              onClick={guard(dismissImport)}
            >
              {lockLabel(locked, 'NOT NOW')}
            </button>
          </div>
        </div>
      )}

      {/* ===== main grid: lattice visualizer / tape rack ===== */}
      <div style={{ display: 'grid', gridTemplateColumns: mobile ? 'minmax(0,1fr)' : 'minmax(0,1.15fr) minmax(0,1fr)', gap: 12, alignItems: 'start' }}>

        {/* --- memory lattice visualizer --- */}
        <div className="wl-equip wl-rust-tr" style={{ padding: '12px 12px 10px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span className="wl-screw wl-screw--tl" /><span className="wl-screw wl-screw--rusty wl-screw--tr" />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 6px' }}>
            <span style={PANEL_LABEL}>MEMORY LATTICE · VISUALIZER</span>
            <span className="wl-mono" style={{ marginLeft: 'auto', fontSize: 7, letterSpacing: 1.5, color: '#8fa0b0' }}>MEM-SCOPE 88</span>
          </div>
          <div className="wl-monitor-bezel">
            <div className="wl-crt" style={{ minHeight: 252, padding: '14px 18px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 10, color: '#3f8f5e', position: 'relative', zIndex: 1 }}>
                &gt; mem.lattice --map --depth {facts.length + episodes.length}
              </div>
              <MemoryGraph
                facts={facts}
                episodes={episodes}
                onSelectFact={selectFromGraph}
                rotX={rot.x}
                rotY={rot.y}
              />
              <div className="wl-crt-text" style={{ fontSize: 10, position: 'relative', zIndex: 1 }}>
                {facts.filter((f) => f.enabled).length} facts live · {episodes.length} episodes logged · drag nodes · click a fact to edit
              </div>
              {/* CRT glass overlays — above the canvas, pointer-events: none */}
              <div className="wl-scanlines" /><div className="wl-glare" /><div className="wl-scanbar" />
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 6px 2px' }}>
            <div className="wl-lcd" style={{ letterSpacing: 2 }}>LATTICE STABLE</div>
            <span className="wl-led wl-led--green wl-led--blink" />
            <div style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
              <div
                className="wl-knob"
                title="rotate Y (yaw)"
                onClick={() => setRot((r) => ({ ...r, y: nextRotStep(r.y) }))}
                style={{ width: 17, height: 17, cursor: 'pointer' }}
              >
                <div className="wl-knob-cap" style={{ width: 10, height: 10 }}>
                  <span className="wl-knob-mark" style={{ ...knobMark, transform: `translateX(-50%) rotate(${rot.y}deg)` }} />
                </div>
              </div>
              <span className="wl-microlabel" style={{ fontSize: 6 }}>YAW</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
              <div
                className="wl-knob"
                title="rotate X (pitch)"
                onClick={() => setRot((r) => ({ ...r, x: nextRotStep(r.x) }))}
                style={{ width: 17, height: 17, cursor: 'pointer' }}
              >
                <div className="wl-knob-cap" style={{ width: 10, height: 10 }}>
                  <span className="wl-knob-mark" style={{ ...knobMark, transform: `translateX(-50%) rotate(${rot.x}deg)` }} />
                </div>
              </div>
              <span className="wl-microlabel" style={{ fontSize: 6 }}>PITCH</span>
            </div>
          </div>
        </div>

        {/* --- tape rack --- */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          {/* record a new tape */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input
              className="wl-input"
              style={{ flex: 1, minWidth: 0 }}
              placeholder="record a durable fact — e.g. 'My repos live in C:\Users\sleve\src'"
              value={newFact}
              onChange={(e) => setNewFact(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && guard(addFact)()}
            />
            <div className="wl-btn-housing">
              <button
                className="wl-btn"
                disabled={!newFact.trim()}
                style={!newFact.trim() ? { opacity: 0.5, cursor: 'default' } : { opacity: locked ? 0.55 : 1 }}
                onClick={guard(addFact)}
              >
                {lockLabel(locked, 'RECORD')}
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={PANEL_LABEL}>TAPE RACK · {facts.length} SHARDS</span>
            <div className="wl-divider" style={{ flex: 1 }} />
            {imp.status === 'scanning' ? (
              <span className="wl-mono" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 9, letterSpacing: 1, color: '#c2a13f' }}>
                <span className="wl-led wl-led--yellow wl-led--blink" /> SCANNING ARCHIVES…
              </span>
            ) : ['dismissed', 'applied', 'failed'].includes(imp.status) && (
              <button
                type="button"
                className="wl-mono"
                title="distill your local Claude memory (~/.claude) into proposed holotapes — nothing is saved without your approval"
                style={{ background: 'transparent', border: '1px solid var(--wl-line)', borderRadius: 2, cursor: 'pointer', fontSize: 9, letterSpacing: 1, padding: '3px 9px', color: '#8fa0b0', opacity: locked ? 0.55 : 1 }}
                onClick={guard(startScan)}
              >
                {lockLabel(locked, '⌬ SCAN LOCAL ARCHIVES')}
              </button>
            )}
          </div>

          {imp.status === 'failed' && (
            <div className="wl-mono" style={{ fontSize: 9.5, color: 'var(--wl-red-hi)', padding: '0 2px' }}>
              ✕ archive scan failed — {imp.error || 'unknown error'}
            </div>
          )}

          {imp.status === 'ready' && (
            <div className="wl-tile" style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={PANEL_LABEL}>ARCHIVE SCAN — PROPOSED HOLOTAPES</span>
                <span className="wl-mono" style={{ fontSize: 9, color: '#8fa0b0' }}>{impSel.size}/{imp.proposals.length} selected</span>
              </div>
              {imp.proposals.length === 0 ? (
                <div className="wl-mono" style={{ fontSize: 10, color: '#8fa0b0' }}>
                  the archives held nothing durable that isn't already on the board.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflowY: 'auto' }}>
                  {imp.proposals.map((f, i) => (
                    <button
                      key={i}
                      type="button"
                      className="wl-mono"
                      style={{
                        display: 'flex', alignItems: 'flex-start', gap: 8, textAlign: 'left', cursor: 'pointer',
                        background: impSel.has(i) ? 'rgba(232,193,74,.12)' : 'transparent',
                        border: `1px solid ${impSel.has(i) ? 'rgba(194,161,63,.55)' : 'var(--wl-line)'}`,
                        borderRadius: 2, padding: '5px 8px', fontSize: 10.5, color: '#c9d4de',
                      }}
                      onClick={() => {
                        const next = new Set(impSel)
                        next.has(i) ? next.delete(i) : next.add(i)
                        setImpSel(next)
                      }}
                    >
                      <span style={{ flex: 'none', color: impSel.has(i) ? 'var(--wl-yellow)' : '#5d6e7e' }}>
                        {impSel.has(i) ? '▣' : '☐'}
                      </span>
                      <span style={{ minWidth: 0 }}>{f}</span>
                    </button>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {imp.proposals.length > 0 && (
                  <div className="wl-btn-housing">
                    <button
                      className="wl-btn"
                      disabled={impSel.size === 0}
                      style={impSel.size === 0 ? { opacity: 0.5, cursor: 'default' } : { opacity: locked ? 0.55 : 1 }}
                      onClick={guard(applyImport)}
                    >
                      {lockLabel(locked, `COMMIT ${impSel.size} TO RACK`)}
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  className="wl-mono"
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 9, letterSpacing: 1, color: '#5d6e7e', opacity: locked ? 0.55 : 1 }}
                  onClick={guard(dismissImport)}
                >
                  {lockLabel(locked, '✕ DISMISS')}
                </button>
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: mobile ? 'minmax(0,1fr)' : 'repeat(2,minmax(0,1fr))', gap: 12, alignItems: 'start' }}>
            {facts.map((f) => (
              <div key={f.id} ref={(el) => { factRefs.current[f.id] = el }} style={{ minWidth: 0 }}>
                <HolotapeCard
                  fact={f}
                  owner={f.agent_key ? owners[f.agent_key] ?? { name: f.agent_key.split(':')[1] || f.agent_key, icon: '◆', color: '#8fa0b0' } : null}
                  highlighted={highlightId === f.id}
                  onChanged={refresh}
                />
              </div>
            ))}
          </div>
          {facts.length === 0 && (
            <div className="wl-tile--inset wl-mono" style={{ borderRadius: 4, padding: '20px 14px', textAlign: 'center', fontSize: 10.5, color: '#5d6e7e' }}>
              rack empty — no holotapes{q ? ' matching your scan' : ' recorded yet. ⌬ SCAN LOCAL ARCHIVES can seed it from your machine’s Claude memory'}.
            </div>
          )}

          {/* --- episode log --- */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
            <span style={PANEL_LABEL}>EPISODE LOG</span>
            <div className="wl-divider" style={{ flex: 1 }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {episodes.map((e) => (
              <Link
                key={e.id}
                to={`/tasks/${e.task_id}`}
                className="wl-tile wl-mono"
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', fontSize: 11, color: '#aebccb', textDecoration: 'none', minWidth: 0 }}
              >
                <span className={`wl-badge ${e.outcome === 'done' ? 'wl-badge--done' : e.outcome === 'failed' ? 'wl-badge--failed' : 'wl-badge--queued'}`}>
                  {e.outcome}
                </span>
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.title}</span>
                <span style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 9, color: '#8fa0b0' }}>
                  ~${e.cost_usd.toFixed(3)} · {new Date(e.created_at).toLocaleDateString()}
                </span>
              </Link>
            ))}
            {episodes.length === 0 && (
              <div className="wl-mono" style={{ fontSize: 10.5, color: '#5d6e7e', padding: '2px 4px' }}>no episodes on record.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
