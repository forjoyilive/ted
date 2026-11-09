import styles from './ReconnectingBar.module.css'

export function ReconnectingBar() {
  return (
    <div className={styles.bar} role="status" aria-label="Reconnecting to TED…">
      <span className={styles.ring} aria-hidden="true" />
      <span className={styles.title}>Reconnecting to TED…</span>
      <span className={styles.detail}>Runs keep going. Actions are off until TED is back.</span>
    </div>
  )
}
