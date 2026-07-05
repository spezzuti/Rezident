import { useEffect, useRef } from 'react'

/**
 * Force-directed "memory lattice" graph on canvas. No libraries — a tiny spring
 * simulation rendered as phosphor-green CRT traces. Center node = the core;
 * facts link to it; tags link to their facts (shared tags create visible
 * cross-structure); recent episodes hang off the core color-coded by outcome.
 * The canvas itself is transparent — the wl-crt tube behind it provides the
 * glass and the glow.
 */

export interface GraphFact { id: string; content: string; tags: string; enabled: number }
export interface GraphEpisode { id: string; title: string; outcome: string; task_id: string }

interface Node {
  id: string
  label: string
  type: 'core' | 'fact' | 'tag' | 'episode'
  x: number; y: number; vx: number; vy: number
  r: number
  color: string
  glow: string
  meta?: any
  fixed?: boolean
  /** per-frame projected screen position + perspective scale (set in render loop) */
  sx?: number; sy?: number; s?: number
}

interface Edge { a: number; b: number; length: number }

/** Canvas can't resolve CSS vars, so read the active theme's values once per
 * graph build. Falls back to wasteland hexes. */
function cssColor(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/** Phosphor CRT palette: facts glow green, tags glow LCD-blue, episodes are
 * dimmer green / desaturated red, the core is enamel yellow. */
function palette() {
  const phosG = cssColor('--wl-phos-g', '#74dd8f')
  const phosGDim = cssColor('--wl-phos-g-dim', '#57a273')
  const phosB = cssColor('--wl-phos-b', '#7fc3e8')
  const yellow = cssColor('--wl-yellow', '#e8c14a')
  const redHi = cssColor('--wl-red-hi', '#dd8471')
  const faint = cssColor('--wl-faint', '#5d6e7e')
  return {
    core: { fill: yellow, glow: yellow },
    fact: { fill: phosG, glow: phosG + '90' },
    factOff: { fill: faint, glow: faint + '50' },
    tag: { fill: phosB, glow: phosB + '99' },
    epOk: { fill: phosGDim, glow: phosGDim + '80' },
    epErr: { fill: redHi, glow: redHi + '80' },
    epOther: { fill: faint, glow: faint + '66' },
  }
}

export default function MemoryGraph({
  facts, episodes, onSelectFact, rotX = 0, rotY = 0,
}: {
  facts: GraphFact[]
  episodes: GraphEpisode[]
  onSelectFact: (id: string) => void
  /** rotation around the X axis (pitch), degrees */
  rotX?: number
  /** rotation around the Y axis (yaw), degrees */
  rotY?: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef<{ nodes: Node[]; edges: Edge[]; drag: number | null; hover: number | null }>({
    nodes: [], edges: [], drag: null, hover: null,
  })
  // latest rotation, read by the render loop each frame — no sim rebuild needed
  const rotRef = useRef({ x: rotX, y: rotY })
  rotRef.current.x = rotX
  rotRef.current.y = rotY

  // (re)build graph when data changes
  useEffect(() => {
    const COLORS = palette()
    const nodes: Node[] = []
    const edges: Edge[] = []
    const W = 800, H = 480

    nodes.push({ id: '__core__', label: 'MEMORY CORE', type: 'core', x: W / 2, y: H / 2, vx: 0, vy: 0, r: 16, ...COLORS.core, color: COLORS.core.fill })

    const tagIndex = new Map<string, number>()
    facts.forEach((f, i) => {
      const angle = (i / Math.max(1, facts.length)) * Math.PI * 2
      const idx = nodes.length
      nodes.push({
        id: f.id, label: f.content.slice(0, 42), type: 'fact',
        x: W / 2 + Math.cos(angle) * 150, y: H / 2 + Math.sin(angle) * 150,
        vx: 0, vy: 0, r: 7,
        color: f.enabled ? COLORS.fact.fill : COLORS.factOff.fill,
        glow: f.enabled ? COLORS.fact.glow : COLORS.factOff.glow,
        meta: f,
      })
      edges.push({ a: 0, b: idx, length: 140 })
      for (const raw of (f.tags || '').split(',')) {
        const tag = raw.trim().toLowerCase()
        if (!tag) continue
        if (!tagIndex.has(tag)) {
          const tIdx = nodes.length
          tagIndex.set(tag, tIdx)
          nodes.push({
            id: `tag:${tag}`, label: `#${tag}`, type: 'tag',
            x: W / 2 + Math.cos(angle + 0.4) * 220, y: H / 2 + Math.sin(angle + 0.4) * 220,
            vx: 0, vy: 0, r: 5, color: COLORS.tag.fill, glow: COLORS.tag.glow,
          })
        }
        edges.push({ a: idx, b: tagIndex.get(tag)!, length: 70 })
      }
    })

    episodes.slice(0, 14).forEach((e, i) => {
      const angle = (i / 14) * Math.PI * 2 + 0.2
      const idx = nodes.length
      const c = e.outcome === 'done' ? COLORS.epOk : e.outcome === 'failed' ? COLORS.epErr : COLORS.epOther
      nodes.push({
        id: e.id, label: e.title.slice(0, 30), type: 'episode',
        x: W / 2 + Math.cos(angle) * 260, y: H / 2 + Math.sin(angle) * 260,
        vx: 0, vy: 0, r: 4.5, color: c.fill, glow: c.glow, meta: e,
      })
      edges.push({ a: 0, b: idx, length: 230 })
    })

    stateRef.current.nodes = nodes
    stateRef.current.edges = edges
  }, [facts, episodes])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    let raf = 0
    let running = true
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let frame = 0

    const cv = canvas
    function resize() {
      const rect = cv.parentElement!.getBoundingClientRect()
      cv.width = rect.width * devicePixelRatio
      cv.height = 480 * devicePixelRatio
      cv.style.height = '480px'
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(cv.parentElement!)

    function step() {
      const { nodes, edges, drag } = stateRef.current
      const W = cv.width / devicePixelRatio
      const H = cv.height / devicePixelRatio
      const cx = W / 2, cy = H / 2

      // physics
      for (let iter = 0; iter < 2; iter++) {
        for (let i = 1; i < nodes.length; i++) {
          const n = nodes[i]
          if (i === drag) continue
          // repulsion
          for (let j = 0; j < nodes.length; j++) {
            if (i === j) continue
            const m = nodes[j]
            let dx = n.x - m.x, dy = n.y - m.y
            let d2 = dx * dx + dy * dy
            if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1 }
            const f = Math.min(1200 / d2, 4)
            const d = Math.sqrt(d2)
            n.vx += (dx / d) * f
            n.vy += (dy / d) * f
          }
          // weak centering
          n.vx += (cx - n.x) * 0.0015
          n.vy += (cy - n.y) * 0.0015
        }
        for (const e of edges) {
          const a = nodes[e.a], b = nodes[e.b]
          const dx = b.x - a.x, dy = b.y - a.y
          const d = Math.max(1, Math.hypot(dx, dy))
          const f = (d - e.length) * 0.004
          const fx = (dx / d) * f, fy = (dy / d) * f
          if (e.a !== drag && e.a !== 0) { a.vx += fx; a.vy += fy }
          if (e.b !== drag) { b.vx -= fx; b.vy -= fy }
        }
        for (let i = 1; i < nodes.length; i++) {
          const n = nodes[i]
          if (i === drag) continue
          n.vx *= 0.86; n.vy *= 0.86
          n.x += n.vx; n.y += n.vy
          n.x = Math.max(20, Math.min(W - 20, n.x))
          n.y = Math.max(20, Math.min(H - 20, n.y))
        }
        nodes[0].x = cx; nodes[0].y = cy
      }

      // render — transparent background, phosphor traces
      ctx.clearRect(0, 0, W, H)
      const pulse = reduced ? 0.5 : (Math.sin(frame / 40) + 1) / 2

      // project flat sim positions through a 3D rotation around the canvas
      // center (yaw around Y, pitch around X) with a little perspective
      const rx = (rotRef.current.x * Math.PI) / 180
      const ry = (rotRef.current.y * Math.PI) / 180
      const cosY = Math.cos(ry), sinY = Math.sin(ry)
      const cosX = Math.cos(rx), sinX = Math.sin(rx)
      const F = 700 // focal length
      for (const n of nodes) {
        const dx = n.x - cx, dy = n.y - cy
        const px = dx * cosY
        const z = dx * sinY
        const py = dy * cosX - z * sinX
        const z2 = dy * sinX + z * cosX
        const s = Math.max(0.5, Math.min(2, F / (F - z2)))
        n.sx = cx + px * s
        n.sy = cy + py * s
        n.s = s
      }

      const phos = cssColor('--wl-phos-g', '#74dd8f')
      for (const e of edges) {
        const a = stateRef.current.nodes[e.a], b = stateRef.current.nodes[e.b]
        ctx.strokeStyle = e.a === 0
          ? phos + Math.round((0.10 + pulse * 0.06) * 255).toString(16).padStart(2, '0')
          : phos + '26'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(a.sx!, a.sy!)
        ctx.lineTo(b.sx!, b.sy!)
        ctx.stroke()
      }

      const { nodes: ns, hover } = stateRef.current
      ns.forEach((n, i) => {
        const s = n.s ?? 1
        const nx = n.sx ?? n.x, ny = n.sy ?? n.y
        const depthAlpha = s < 1 ? 0.55 + 0.45 * s : 1 // dim far-side nodes
        ctx.save()
        ctx.globalAlpha = depthAlpha
        ctx.shadowColor = n.glow
        ctx.shadowBlur = n.type === 'core' ? 30 + pulse * 20 : i === hover ? 22 : 12
        ctx.fillStyle = n.color
        ctx.beginPath()
        ctx.arc(nx, ny, (n.r + (n.type === 'core' ? pulse * 2 : 0)) * s, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()

        if (n.type === 'core' || i === hover || n.type === 'tag') {
          ctx.save()
          ctx.globalAlpha = depthAlpha
          ctx.font = n.type === 'core'
            ? '600 9px "IBM Plex Mono", Consolas, monospace'
            : '10px "IBM Plex Mono", Consolas, monospace'
          ctx.fillStyle = n.type === 'core'
            ? '#2a2410'
            : i === hover ? '#d9ffe4' : 'rgba(116,221,143,0.55)'
          ctx.textAlign = 'center'
          if (n.type === 'core') {
            ctx.fillText('CORE', nx, ny + 3)
          } else {
            ctx.fillText(n.label, nx, ny - n.r * s - 6)
          }
          ctx.restore()
        }
      })
      frame++
      if (running) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)

    function pick(e: MouseEvent): number | null {
      const rect = cv.getBoundingClientRect()
      const x = e.clientX - rect.left, y = e.clientY - rect.top
      const { nodes } = stateRef.current
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i]
        const nx = n.sx ?? n.x, ny = n.sy ?? n.y
        if (Math.hypot(nx - x, ny - y) < n.r * (n.s ?? 1) + 8) return i
      }
      return null
    }
    const onMove = (e: MouseEvent) => {
      const st = stateRef.current
      if (st.drag !== null) {
        const n = st.nodes[st.drag]
        // apply the screen-space mouse delta to the flat sim position,
        // compensated by the node's perspective scale
        const s = n.s || 1
        n.x += e.movementX / s
        n.y += e.movementY / s
        n.vx = 0; n.vy = 0
      } else {
        st.hover = pick(e)
        cv.style.cursor = st.hover !== null ? 'pointer' : 'default'
      }
    }
    const onDown = (e: MouseEvent) => {
      const i = pick(e)
      if (i !== null && i !== 0) stateRef.current.drag = i
    }
    const onUp = (e: MouseEvent) => {
      const st = stateRef.current
      if (st.drag !== null) {
        const n = st.nodes[st.drag]
        const moved = Math.hypot(e.movementX, e.movementY)
        if (n.type === 'fact' && moved < 3) onSelectFact(n.id)
        st.drag = null
      } else {
        const i = pick(e)
        if (i !== null) {
          const n = st.nodes[i]
          if (n.type === 'fact') onSelectFact(n.id)
          if (n.type === 'episode' && n.meta?.task_id) window.location.href = `/tasks/${n.meta.task_id}`
        }
      }
    }
    canvas.addEventListener('mousemove', onMove)
    canvas.addEventListener('mousedown', onDown)
    canvas.addEventListener('mouseup', onUp)
    return () => {
      running = false
      cancelAnimationFrame(raf)
      ro.disconnect()
      canvas.removeEventListener('mousemove', onMove)
      canvas.removeEventListener('mousedown', onDown)
      canvas.removeEventListener('mouseup', onUp)
    }
  }, [onSelectFact])

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%' }} />
    </div>
  )
}
