import { Button } from '../components/Button.tsx'
import { EmptyState } from '../components/EmptyState.tsx'
import views from './views.module.css'

export function NoFactories({ onAddFactory }: { onAddFactory: () => void }) {
  return (
    <div className={views.pane}>
      <EmptyState
        title="No Factories yet"
        line="A Factory carries Tasks from request to merge for one product."
      >
        <Button variant="primary" onClick={onAddFactory}>
          Add Factory…
        </Button>
      </EmptyState>
    </div>
  )
}
