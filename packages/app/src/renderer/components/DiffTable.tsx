import type { DiffHunk, DiffRow, FileDiff } from '@ted/protocol'
import { type ReactNode, useEffect, useState } from 'react'
import styles from './DiffTable.module.css'

const marks = { context: ' ', added: '+', removed: '−' } as const

export type RowExtra = (row: DiffRow, hunk: DiffHunk) => ReactNode

export interface Gutter {
  onPick: (hunk: DiffHunk, rows: DiffRow[]) => void
  picked?: (row: DiffRow) => boolean
}

export const rowKey = (row: Pick<DiffRow, 'old' | 'new'>) => `${row.old ?? ''}:${row.new ?? ''}`

export function FileDiffBody({
  diff,
  after,
  gutter,
}: {
  diff: FileDiff
  after?: RowExtra | undefined
  gutter?: Gutter | undefined
}) {
  const [committedOnly, setCommittedOnly] = useState<boolean>()
  const committed = diff.committedHunks
  if (!committed) return <DiffTable diff={diff} after={after} gutter={gutter} />
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
        <span>Committed only excludes uncommitted edits; it may include unpushed commits.</span>
      </div>
      {showCommitted ? (
        <DiffTable diff={{ ...diff, hunks: committed }} />
      ) : (
        <DiffTable diff={diff} after={after} gutter={gutter} />
      )}
    </>
  )
}

interface Drag {
  hunk: number
  from: number
  to: number
}

export function DiffTable({
  diff,
  after,
  gutter,
}: {
  diff: FileDiff
  after?: RowExtra | undefined
  gutter?: Gutter | undefined
}) {
  const [drag, setDrag] = useState<Drag>()
  useEffect(() => {
    if (!drag || !gutter) return
    const finish = () => {
      const hunk = diff.hunks[drag.hunk]
      if (hunk) gutter.onPick(hunk, hunk.rows.slice(drag.from, drag.to + 1))
      setDrag(undefined)
    }
    window.addEventListener('mouseup', finish)
    return () => window.removeEventListener('mouseup', finish)
  }, [drag, gutter, diff.hunks])
  if (diff.unavailable) return <p className={styles.note}>{diff.unavailable}</p>
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
      <table className={styles.table} data-commenting={gutter ? true : undefined}>
        <colgroup>
          <col className={styles.numberColumn} />
          <col className={styles.numberColumn} />
          <col className={styles.markColumn} />
          <col />
        </colgroup>
        {diff.hunks.map((hunk, h) => (
          <tbody key={hunk.header}>
            <tr className={styles.hunk}>
              <td colSpan={4}>{hunk.header}</td>
            </tr>
            {hunk.rows.map((row, i) => {
              const extra = after?.(row, hunk)
              const key = rowKey(row)
              const dragged = drag?.hunk === h && i >= drag.from && i <= drag.to
              const picked = dragged || gutter?.picked?.(row) === true
              return [
                <tr
                  key={key}
                  className={`${styles[row.kind]} ${picked ? styles.picked : ''}`}
                  data-old={row.old}
                  data-new={row.new}
                  onMouseEnter={() => {
                    if (drag?.hunk === h && i >= drag.from) setDrag({ ...drag, to: i })
                  }}
                >
                  <td className={styles.number}>{row.old}</td>
                  <td className={`${styles.number} ${styles.gutter}`}>
                    {row.new}
                    {gutter && (
                      <button
                        type="button"
                        className={styles.plus}
                        aria-label={`Comment on line ${row.new ?? row.old}`}
                        title="Comment on this line, or drag down for a range"
                        onMouseDown={(event) => {
                          if (event.button !== 0) return
                          event.preventDefault()
                          setDrag({ hunk: h, from: i, to: i })
                        }}
                        onClick={(event) => {
                          if (event.detail === 0) gutter.onPick(hunk, [row])
                        }}
                      />
                    )}
                  </td>
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
      {diff.truncated && <p className={styles.note}>Longer than Ted shows here.</p>}
    </>
  )
}
