import type { ReactNode } from 'react'
import styles from './StatusChip.module.css'

export type StatusTone = 'working' | 'waiting' | 'failed' | 'neutral' | 'success' | 'testing'

export type StatusGlyph =
  | 'failed'
  | 'partly'
  | 'waiting'
  | 'paused'
  | 'working'
  | 'stopped'
  | 'blocked'
  | 'queued'
  | 'ci'
  | 'review'
  | 'merge'

const ring =
  'M8.9 5C8.9 7.15391 7.15391 8.9 5 8.9C2.84609 8.9 1.1 7.15391 1.1 5C1.1 2.84609 2.84609 1.1 5 1.1C7.15391 1.1 8.9 2.84609 8.9 5Z'
const dashedRing =
  'M8.82818 4.25116C8.87531 4.4935 8.9 4.74387 8.9 5C8.9 5.25613 8.87531 5.5065 8.82818 5.74884M8.23611 2.82269C7.95472 2.40529 7.59471 2.04528 7.17731 1.76389M5.74884 1.17182C5.5065 1.12469 5.25613 1.1 5 1.1C4.74387 1.1 4.4935 1.12469 4.25116 1.17182M2.82269 1.76389C2.40529 2.04528 2.04528 2.40529 1.76389 2.82269M1.17182 4.25116C1.12469 4.4935 1.1 4.74387 1.1 5C1.1 5.25613 1.12469 5.5065 1.17182 5.74884M1.76389 7.17731C2.04528 7.59471 2.40529 7.95472 2.82269 8.23611M4.25116 8.82818C4.4935 8.87531 4.74387 8.9 5 8.9C5.25613 8.9 5.5065 8.87531 5.74884 8.82818M7.17731 8.23611C7.59471 7.95472 7.95472 7.59471 8.23611 7.17731'

function Glyph({ glyph }: { glyph: StatusGlyph }) {
  const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }
  switch (glyph) {
    case 'failed':
      return (
        <>
          <circle cx="5" cy="5" r="4.5" fill="currentColor" />
          <path
            className={styles.onFill}
            d="M5.65 2.95C5.65 2.59101 5.35899 2.3 5 2.3C4.64101 2.3 4.35 2.59101 4.35 2.95V5.15C4.35 5.50899 4.64101 5.8 5 5.8C5.35899 5.8 5.65 5.50899 5.65 5.15V2.95Z"
          />
          <circle className={styles.onFill} cx="5" cy="7.5" r="0.75" />
        </>
      )
    case 'partly':
      return (
        <>
          <path d={ring} {...stroke} />
          <path
            d="M5 1.1C3.96566 1.1 2.97368 1.51089 2.24228 2.24228C1.51089 2.97368 1.1 3.96566 1.1 5C1.1 6.03434 1.51089 7.02632 2.24228 7.75772C2.97368 8.48911 3.96566 8.9 5 8.9V1.1Z"
            fill="currentColor"
          />
        </>
      )
    case 'waiting':
      return <circle cx="5" cy="5" r="3.5" fill="currentColor" />
    case 'paused':
      return (
        <>
          <rect x="2.6" y="2" width="1.7" height="6" rx="0.5" fill="currentColor" />
          <rect x="5.7" y="2" width="1.7" height="6" rx="0.5" fill="currentColor" />
        </>
      )
    case 'working':
      return (
        <>
          <path d={ring} fill="none" stroke="currentColor" strokeWidth="1.4" strokeOpacity="0.3" />
          <path
            d="M5 1.1C5.51216 1.1 6.0193 1.20088 6.49247 1.39687C6.96564 1.59286 7.39557 1.88014 7.75772 2.24228C8.11987 2.60443 8.40714 3.03436 8.60313 3.50753C8.79912 3.9807 8.9 4.48784 8.9 5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </>
      )
    case 'stopped':
      return <rect x="2" y="2" width="6" height="6" rx="1" fill="currentColor" />
    case 'blocked':
      return (
        <>
          <path d={ring} {...stroke} />
          <path d="M2.3 7.7L7.7 2.3" {...stroke} />
        </>
      )
    case 'queued':
      return (
        <>
          <path d={ring} {...stroke} />
          <path d="M5 2.9V5L6.5 6" {...stroke} strokeLinecap="round" strokeLinejoin="round" />
        </>
      )
    case 'ci':
      return <path d={dashedRing} {...stroke} />
    case 'review':
      return (
        <>
          <path d={dashedRing} {...stroke} />
          <circle cx="5" cy="5" r="1.5" fill="currentColor" />
        </>
      )
    case 'merge':
      return (
        <>
          <path d={dashedRing} {...stroke} />
          <path
            d="M5 2.4C5.68956 2.4 6.35088 2.67393 6.83848 3.16152C7.32607 3.64912 7.6 4.31044 7.6 5C7.6 5.68956 7.32607 6.35088 6.83848 6.83848C6.35088 7.32607 5.68956 7.6 5 7.6V2.4Z"
            fill="currentColor"
          />
        </>
      )
  }
}

export function statusChipClass(tone: StatusTone, tall = false): string {
  return [styles.chip, styles[tone], tall && styles.tall].filter(Boolean).join(' ')
}

export function StatusGlyphIcon({ glyph }: { glyph: StatusGlyph }) {
  return (
    <svg
      className={glyph === 'working' ? `${styles.glyph} ${styles.spinning}` : styles.glyph}
      width="10"
      height="10"
      viewBox="0 0 10 10"
      aria-hidden
    >
      <Glyph glyph={glyph} />
    </svg>
  )
}

export function StatusChip({
  tone,
  glyph,
  children,
  title,
  tall = false,
}: {
  tone: StatusTone
  glyph?: StatusGlyph
  children: ReactNode
  title?: string | undefined
  tall?: boolean
}) {
  return (
    <span className={statusChipClass(tone, tall)} title={title}>
      {glyph && <StatusGlyphIcon glyph={glyph} />}
      {children}
    </span>
  )
}
