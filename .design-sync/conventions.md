# AgentOS conventions (read before building)

AgentOS is a skeuomorphic, Fallout-inspired "PIP-OS" vault-console system: painted-steel equipment panels, green-phosphor CRT monitors, physical buttons/knobs/toggles, and paper/handwriting accents on a dark steel canvas. Every design is dark-first: set the page background to `var(--wl-bg-0)` `#181f26` (or the `.wl-app` gradient) — components are illegible on white.

## The wl-* design language (preferred for page structure)

Panels: `.wl-equip` (painted-steel panel; add `.wl-rust-bl`/`.wl-rust-tr` rust overlays and corner `<span class="wl-screw wl-screw--tl"/>` screws, `--rusty` variant). Recessed instrument wells: `.wl-tile` / `.wl-tile--inset`. Terminal surfaces: `.wl-monitor-bezel > .wl-crt` with child overlays `.wl-scanlines`, `.wl-glare`, `.wl-scanbar`; phosphor text `.wl-crt-text`, blinking `.wl-cursor`, boot `.wl-power-on`. Readouts: `.wl-lcd`. Controls: yellow physical `.wl-btn` (wrap in `.wl-btn-housing`), `.wl-btn--steel`, `.wl-knob > .wl-knob-cap > .wl-knob-mark`, `.wl-toggle(.on) > .wl-toggle-lever`, `.wl-led--green/--yellow/--red/--blue/--off (+--blink)`, analog `.wl-gauge` (rotate `.wl-needle` −90..90deg). Labels: `.wl-sectionlabel`, `.wl-nav-label`, `.wl-nav-item(.active)`, `.wl-microlabel`, engraved `.wl-nameplate > .wl-engraved`. Status: `.wl-badge--done/--running/--failed/--queued/--cancelled`. Dividers: `.wl-chevron` (caution stripe), `.wl-divider`. Paper: `.wl-sticky` (+`-paper`/`-curl`/`-tape`), handwriting `.wl-hand` (Caveat), data `.wl-mono` (IBM Plex Mono), display font Chakra Petch. Inputs: `.wl-input` (phosphor terminal input). Tables: `.wl-table`. Key vars: `--wl-bg-0/1`, `--wl-well`, `--wl-line`, `--wl-steel*`, `--wl-cream/text/dim/faint`, `--wl-yellow`, `--wl-blue`, `--wl-red(-hi)`, `--wl-green`, `--wl-phos-g/b(+-glow)`, `--wl-paper*`.

## Setup

- **Wrap the app in `DSProvider`** (exported from the bundle). `TaskCard` and `NewTaskModal` render router links and **throw without it**.
- Optional page atmosphere: `.os-backdrop` (fixed, z -2, grid + dust) as the first child of the page; `<Ambient color="var(--sec-console)"/>` inside any `position: relative` page container for a section-colored top wash.
- Two themes ship: default wasteland, and `<html data-theme="cyber">` for the neon-green Hackers variant. All tokens swap automatically — never hardcode hexes.

## Styling idiom: CSS variables + a small fixed utility vocabulary

The stylesheet is compiled Tailwind — **only the classes below and the ones in shipped component markup exist; do not invent other utility classes.** For your own layout glue, use inline styles with the tokens.

Core tokens: `--color-bg`, `--color-panel`, `--color-panel-2`, `--color-input`, `--color-edge`, `--color-ink`, `--color-ink-2`, `--color-ink-dim`, `--color-ink-dimmer`, `--color-accent` (amber), `--color-gold`, `--color-ok` (pip green), `--color-warn`, `--color-err`, `--color-violet`, `--font-mono`, `--panel-radius`.

Section accents (one hue per app area): `--sec-console`, `--sec-board`, `--sec-comms`, `--sec-pipes`, `--sec-sched`, `--sec-memory`, `--sec-companions`, `--sec-dreams`, `--sec-vault`, `--sec-system`.

Alpha idiom: `color-mix(in srgb, var(--color-accent) 27%, transparent)` — never hex-suffix a var.

Reusable classes: `.glass` (panel box), `.glass-bright` (accented panel), `.hud-label` (mono uppercase bracketed section label), `.hud-corner` (corner brackets), `.fo-tab` (inverse-video Pip-Boy tab strip), `.neon-divider`, `.neon-text`, `.metric` (big mono number), `.btn-glow` / `.focus-glow` (themed glows; set `--glow-c` inline to a section color), `.event-in` (fade-slide entrance), `.dot-running` (pulse), `.card-running` / `.card-awaiting` / `.card-verifying` (status border glows), `.shimmer-bar`, `.stream-cursor`, `.ticker-track`, `.scanlines`, `.os-backdrop`.

## Where the truth lives

Read `styles.css` → `_ds_bundle.css` (full compiled theme incl. both theme blocks) before styling anything; per-component API is each `components/general/<Name>/<Name>.d.ts` with usage in `<Name>.prompt.md`.

## Idiomatic snippet

```tsx
<DSProvider>
  <div style={{ position: 'relative', minHeight: '100vh', background: 'var(--color-bg)', color: 'var(--color-ink)' }}>
    <Ambient color="var(--sec-console)" />
    <div className="hud-label" style={{ padding: 16 }}>Overseer Console</div>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: 16 }}>
      <StatTile label="Caps spent today" color="var(--sec-sched)"><CountUp value={1.28} prefix="$" decimals={2} /></StatTile>
      <div className="glass" style={{ padding: 12 }}>
        <StatusPill status="running" />
      </div>
    </div>
  </div>
</DSProvider>
```
