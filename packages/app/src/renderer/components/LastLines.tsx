import { useState } from 'react'
import styles from './LastLines.module.css'

export const shownLines = 10

export function lastLines(text: string, count = shownLines) {
  const lines = text.replace(/\n$/, '').split('\n')
  return {
    total: lines.length,
    hidden: Math.max(0, lines.length - count),
    tail: lines.slice(-count).join('\n'),
  }
}

export function useLastLines(text: string) {
  const [expanded, setExpanded] = useState(false)
  const lines = lastLines(text)
  const collapsed = !expanded && lines.hidden > 0
  const toggle =
    lines.hidden === 0 ? null : (
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={expanded}
        onClick={() => setExpanded((shown) => !shown)}
      >
        {expanded ? (
          <span className={styles.action}>Show the last {shownLines} lines only</span>
        ) : (
          <>
            {lines.hidden} earlier {lines.hidden === 1 ? 'line' : 'lines'} hidden ·{' '}
            <span className={styles.action}>Show all {lines.total} lines</span>
          </>
        )}
      </button>
    )
  return { collapsed, tail: lines.tail, toggle }
}
