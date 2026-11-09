import { Help } from '../components/Help.tsx'
import styles from './views.module.css'

export function Inbox() {
  return (
    <>
      <section className={`${styles.pane} ${styles.listPane}`} aria-label="Inbox">
        <header className={`${styles.header} ${styles.listHeader}`}>
          <h1 className={styles.listTitle}>Inbox</h1>
          <Help>
            Questions and sign-offs from agents that need your answer, from every Factory.
          </Help>
        </header>
        <p className={styles.empty}>Nothing is waiting on you.</p>
      </section>
      <section className={styles.pane} aria-label="Nothing open" />
    </>
  )
}

export function Stub({ title }: { title: string }) {
  return (
    <section className={styles.pane} aria-label={title}>
      <header className={styles.header}>
        <h1 className={styles.title}>{title}</h1>
      </header>
      <p className={styles.empty}>Not built yet.</p>
    </section>
  )
}
