/** Design-system entry for design-sync: the reusable Rezident UI surface.
 * The app itself boots from main.tsx; this file exists so the DS bundle
 * exports only components, never the app bootstrap. */
export { default as StatusPill } from './components/StatusPill'
export { default as TaskCard } from './components/TaskCard'
export { CountUp, StatTile } from './components/CostMeter'
export { default as Ambient } from './components/Ambient'
export { default as MemoryGraph } from './components/MemoryGraph'
export { default as NewTaskModal } from './components/NewTaskModal'
export { DSProvider } from './ds-provider'
