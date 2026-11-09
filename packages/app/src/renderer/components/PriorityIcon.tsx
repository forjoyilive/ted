import styles from './PriorityIcon.module.css'

export type Priority = 'urgent' | 'high' | 'medium' | 'low' | 'none'

const labels: Record<Priority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'No priority',
}

const bars = [
  'M3 7H2C1.44772 7 1 7.44772 1 8V12C1 12.5523 1.44772 13 2 13H3C3.55228 13 4 12.5523 4 12V8C4 7.44772 3.55228 7 3 7Z',
  'M7.5 4H6.5C5.94772 4 5.5 4.44772 5.5 5V12C5.5 12.5523 5.94772 13 6.5 13H7.5C8.05228 13 8.5 12.5523 8.5 12V5C8.5 4.44772 8.05228 4 7.5 4Z',
  'M12 1H11C10.4477 1 10 1.44772 10 2V12C10 12.5523 10.4477 13 11 13H12C12.5523 13 13 12.5523 13 12V2C13 1.44772 12.5523 1 12 1Z',
]

const dashes = [
  'M2.5 6H2C1.44772 6 1 6.44772 1 7V7.5C1 8.05228 1.44772 8.5 2 8.5H2.5C3.05228 8.5 3.5 8.05228 3.5 7.5V7C3.5 6.44772 3.05228 6 2.5 6Z',
  'M7 6H6.5C5.94772 6 5.5 6.44772 5.5 7V7.5C5.5 8.05228 5.94772 8.5 6.5 8.5H7C7.55228 8.5 8 8.05228 8 7.5V7C8 6.44772 7.55228 6 7 6Z',
  'M11.5 6H11C10.4477 6 10 6.44772 10 7V7.5C10 8.05228 10.4477 8.5 11 8.5H11.5C12.0523 8.5 12.5 8.05228 12.5 7.5V7C12.5 6.44772 12.0523 6 11.5 6Z',
]

const lit: Record<'high' | 'medium' | 'low', number> = { high: 3, medium: 2, low: 1 }

export function PriorityIcon({ priority }: { priority: Priority }) {
  return (
    <svg
      className={styles.icon}
      width="14"
      height="14"
      viewBox="0 0 14 14"
      role="img"
      aria-label={labels[priority]}
    >
      {priority === 'urgent' ? (
        <>
          <path
            className={styles.urgent}
            d="M10.5 0.5H3.5C1.84315 0.5 0.5 1.84315 0.5 3.5V10.5C0.5 12.1569 1.84315 13.5 3.5 13.5H10.5C12.1569 13.5 13.5 12.1569 13.5 10.5V3.5C13.5 1.84315 12.1569 0.5 10.5 0.5Z"
          />
          <path
            className={styles.urgentGlyph}
            d="M7.7 3.5C7.7 3.1134 7.3866 2.8 7 2.8C6.6134 2.8 6.3 3.1134 6.3 3.5V7.1C6.3 7.4866 6.6134 7.8 7 7.8C7.3866 7.8 7.7 7.4866 7.7 7.1V3.5Z"
          />
          <path
            className={styles.urgentGlyph}
            d="M7 10.4C7.44183 10.4 7.8 10.0418 7.8 9.6C7.8 9.15817 7.44183 8.8 7 8.8C6.55817 8.8 6.2 9.15817 6.2 9.6C6.2 10.0418 6.55817 10.4 7 10.4Z"
          />
        </>
      ) : priority === 'none' ? (
        dashes.map((d) => <path key={d} className={styles.none} d={d} />)
      ) : (
        bars.map((d, i) => (
          <path key={d} className={i < lit[priority] ? styles.bar : styles.barDim} d={d} />
        ))
      )}
    </svg>
  )
}
