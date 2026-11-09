import type { ReactNode } from 'react'
import styles from './views.module.css'

export function Stub({ title, banners }: { title: string; banners?: ReactNode }) {
  return (
    <section className={styles.pane} aria-label={title}>
      <header className={styles.header}>
        <h1 className={styles.title}>{title}</h1>
      </header>
      {banners}
      <p className={styles.empty}>Not built yet.</p>
    </section>
  )
}
