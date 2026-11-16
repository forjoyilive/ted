import type { CSSProperties } from 'react'
import { Button } from './Button.tsx'
import styles from './Loading.module.css'

export function Loading({
  label = 'Loading…',
  terminal = false,
  compact = false,
}: {
  label?: string
  terminal?: boolean
  compact?: boolean
}) {
  return (
    <span
      className={`${styles.loading} ${terminal ? styles.terminal : ''} ${compact ? styles.compact : ''}`}
      role="status"
      aria-label={label}
    >
      <span className={styles.spinner} aria-hidden />
    </span>
  )
}

export function SkeletonBar({
  width = '100%',
  height = 12,
}: {
  width?: CSSProperties['width']
  height?: number
}) {
  return <span className={styles.bar} style={{ width, height }} aria-hidden />
}

export function Skeleton({
  label = 'Loading…',
  shape = 'text',
  rows = 3,
  framed = true,
}: {
  label?: string
  shape?: 'text' | 'settings' | 'history'
  rows?: 1 | 2 | 3
  framed?: boolean
}) {
  return (
    <div className={styles.skeleton} role="status" aria-label={label}>
      <div
        className={`${styles[shape]} ${shape === 'settings' && framed ? styles.framed : ''}`}
        aria-hidden
      >
        {['first', 'second', 'third'].slice(0, rows).map((row) => (
          <div className={styles.row} key={row}>
            {shape === 'history' && <span className={styles.avatar} />}
            <div className={styles.lines}>
              <span className={styles.short} />
              <span className={styles.long} />
              <span className={styles.medium} />
            </div>
            {shape === 'settings' && <span className={styles.control} />}
          </div>
        ))}
      </div>
    </div>
  )
}

export function LoadingError({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div className={styles.error} role="alert">
      <span>{error}</span>
      <Button onClick={retry}>Try again</Button>
    </div>
  )
}

export function LoadingScreen({ label = 'Loading Ted…' }: { label?: string }) {
  return (
    <main className={styles.screen}>
      <Loading label={label} />
    </main>
  )
}
