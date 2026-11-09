import type { ReactNode } from 'react'
import styles from './EmptyState.module.css'
import { Help } from './Help.tsx'

export function EmptyState({
  title,
  line,
  help,
  card = false,
  children,
}: {
  title: string
  line?: string
  help?: ReactNode
  card?: boolean
  children?: ReactNode
}) {
  return (
    <section className={card ? `${styles.empty} ${styles.card}` : styles.empty} aria-label={title}>
      <h2 className={styles.title}>
        {title}
        {help !== undefined && <Help>{help}</Help>}
      </h2>
      {line !== undefined && <p className={styles.line}>{line}</p>}
      {children !== undefined && <div className={styles.actions}>{children}</div>}
    </section>
  )
}
