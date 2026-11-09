import { Button } from '../components/Button.tsx'
import styles from './NoFactories.module.css'

export function NoFactories({ onAddFactory }: { onAddFactory: () => void }) {
  return (
    <section className={styles.empty} aria-label="No Factories">
      <h1 className={styles.title}>No Factories yet</h1>
      <p className={styles.line}>A Factory carries Tasks from request to merge for one product.</p>
      <Button variant="primary" onClick={onAddFactory}>
        Add Factory
      </Button>
    </section>
  )
}
