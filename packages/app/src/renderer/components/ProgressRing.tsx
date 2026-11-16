import { progressCount, progressLabel } from '../hierarchy.ts'
import styles from './ProgressRing.module.css'

const size = 14
const stroke = 2.5
const radius = (size - stroke) / 2
const circumference = 2 * Math.PI * radius
const centre = size / 2

export function ProgressRing({
  merged,
  total,
  className,
}: {
  merged: number
  total: number
  className?: string | undefined
}) {
  const done = total > 0 && merged >= total
  const label = progressLabel({ merged, total })
  const filled = total > 0 ? (circumference * Math.min(merged, total)) / total : 0
  return (
    <span
      className={[styles.progress, done && styles.done, className].filter(Boolean).join(' ')}
      role="img"
      aria-label={label}
      title={label}
      data-child-progress
      data-done={done || undefined}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle className={styles.track} cx={centre} cy={centre} r={radius} strokeWidth={stroke} />
        {merged > 0 && (
          <circle
            className={styles.arc}
            cx={centre}
            cy={centre}
            r={radius}
            strokeWidth={stroke}
            strokeDasharray={`${filled} ${circumference}`}
            transform={`rotate(-90 ${centre} ${centre})`}
          />
        )}
      </svg>
      <span aria-hidden>{progressCount({ merged, total })}</span>
    </span>
  )
}
