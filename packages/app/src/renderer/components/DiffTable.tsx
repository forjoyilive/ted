import type { DiffHunk, DiffRow, FileDiff } from '@ted/protocol'
import { type ReactNode, useState } from 'react'
import styles from './DiffTable.module.css'

const marks = { context: ' ', added: '+', removed: '−' } as const

export type RowExtra = (row: DiffRow, hunk: DiffHunk) => ReactNode

export function FileDiffBody({ diff, after }: { diff: FileDiff; after?: RowExtra | undefined }) {
  const [committedOnly, setCommittedOnly] = useState<boolean>()
  const committed = diff.committedHunks
  if (!committed) return <DiffTable diff={diff} after={after} />
  const showCommitted = committedOnly ?? diff.hunks.length === 0
  return (
    <>
      <div className={styles.versions}>
        <span className={styles.toggle}>
          <button
            type="button"
            aria-pressed={!showCommitted}
            onClick={() => setCommittedOnly(false)}
          >
            With uncommitted work
          </button>
          <button type="button" aria-pressed={showCommitted} onClick={() => setCommittedOnly(true)}>
            Committed only
          </button>
        </span>
        <span>
          Uncommitted work changes this file. The pull request gets the committed version.
        </span>
      </div>
      <DiffTable diff={showCommitted ? { ...diff, hunks: committed } : diff} after={after} />
    </>
  )
}

export function DiffTable({ diff, after }: { diff: FileDiff; after?: RowExtra | undefined }) {
  if (diff.binary) return <p className={styles.note}>Binary file, so there are no lines to show.</p>
  if (diff.hunks.length === 0) {
    return (
      <p className={styles.note}>
        {diff.truncated ? 'This diff is too large to show here.' : 'No line changes.'}
      </p>
    )
  }
  return (
    <>
      <table className={styles.table}>
        <colgroup>
          <col className={styles.numberColumn} />
          <col className={styles.numberColumn} />
          <col className={styles.markColumn} />
          <col />
        </colgroup>
        {diff.hunks.map((hunk) => (
          <tbody key={hunk.header}>
            <tr className={styles.hunk}>
              <td colSpan={4}>{hunk.header}</td>
            </tr>
            {hunk.rows.map((row) => {
              const extra = after?.(row, hunk)
              const key = `${row.old ?? ''}:${row.new ?? ''}`
              return [
                <tr key={key} className={styles[row.kind]}>
                  <td className={styles.number}>{row.old}</td>
                  <td className={styles.number}>{row.new}</td>
                  <td className={styles.mark}>{marks[row.kind]}</td>
                  <td className={styles.text}>{row.text}</td>
                </tr>,
                extra && (
                  <tr key={`${key}:after`} className={styles.extra}>
                    <td colSpan={4}>{extra}</td>
                  </tr>
                ),
              ]
            })}
          </tbody>
        ))}
      </table>
      {diff.truncated && <p className={styles.note}>Longer than TED shows here.</p>}
    </>
  )
}
