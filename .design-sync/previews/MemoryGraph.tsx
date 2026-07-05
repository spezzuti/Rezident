import { MemoryGraph } from 'agentos-frontend'

const facts = [
  { id: 'f1', content: 'My repos live in C:\\Users\\sleve\\src', tags: 'repos, paths', enabled: 1 },
  { id: 'f2', content: 'Prefer pytest over unittest for verification', tags: 'testing', enabled: 1 },
  { id: 'f3', content: 'Deploys go through staging first, never straight to prod', tags: 'deploys, safety', enabled: 1 },
  { id: 'f4', content: 'Weekly cost budget is $25', tags: 'costs', enabled: 1 },
  { id: 'f5', content: 'Old Jenkins pipeline is deprecated', tags: 'deploys', enabled: 0 },
]

const episodes = [
  { id: 'e1', title: 'Refactor auth middleware', outcome: 'done', task_id: 't1' },
  { id: 'e2', title: 'Nightly repo digest', outcome: 'done', task_id: 't2' },
  { id: 'e3', title: 'Migrate database schema', outcome: 'failed', task_id: 't3' },
  { id: 'e4', title: 'Weekly cost audit', outcome: 'done', task_id: 't4' },
  { id: 'e5', title: 'Prototype voice control', outcome: 'cancelled', task_id: 't5' },
]

export const NeuralMap = () => (
  <div style={{ padding: 8 }}>
    <MemoryGraph facts={facts} episodes={episodes} onSelectFact={() => {}} />
  </div>
)
