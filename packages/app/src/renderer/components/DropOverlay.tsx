import styles from './DropOverlay.module.css'

export function DropOverlay({ caption }: { caption: string }) {
  return (
    <div className={styles.overlay} aria-hidden>
      <span className={styles.title}>Drop to attach</span>
      <span className={styles.caption}>{caption}</span>
    </div>
  )
}
