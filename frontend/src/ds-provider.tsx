import { MemoryRouter } from 'react-router-dom'

/** Preview/design-time wrapper: several Rezident components (TaskCard,
 * NewTaskModal) render react-router <Link>/useNavigate and need a router
 * in context. Designs built with this DS should wrap their tree in it. */
export function DSProvider({ children }: { children?: React.ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>
}
