import { useState } from 'react'
import { useSlots, useTedStops } from '../data.ts'
import { stageName } from '../list-view.ts'
import { readableError, ted } from '../ted.ts'
import { tedStopsText } from '../ted-stops.ts'
import { formatTime } from '../time.ts'
import archive from './ArchiveDialogs.module.css'
import { Dialog } from './ArchiveDialogs.tsx'
import { Button } from './Button.tsx'
import styles from './RestartStoppedDialog.module.css'

export function RestartStoppedDialog() {
  const offered = useTedStops()
  const slots = useSlots()
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set())
  const stops = offered.filter((task) => !answered.has(task.id))
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  if (stops.length === 0) return null

  const picked = stops.filter((task) => !unticked.has(task.id))
  const stoppedAt =
    stops
      .map((task) => task.stoppedAt)
      .toSorted()
      .at(-1) ?? ''
  const text = tedStopsText({
    count: stops.length,
    picked: picked.length,
    stoppedAt: formatTime(stoppedAt),
    freeSlots: slots ? Math.max(0, slots.limit - slots.working) : 0,
  })
  const answer = (restart: readonly string[]) => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    const restarting = new Set(restart)
    const asked = stops.map((task) => task.id)
    ted
      .answerTedStops({
        restart: [...restarting],
        leave: asked.filter((id) => !restarting.has(id)),
      })
      .then(
        (left) => {
          const still = new Set(left.map((task) => task.id))
          setAnswered((before) => new Set([...before, ...asked.filter((id) => !still.has(id))]))
        },
        (failure: unknown) => setError(readableError(failure)),
      )
      .finally(() => setBusy(false))
  }
  const toggle = (id: string, on: boolean) => {
    const next = new Set(unticked)
    if (on) next.delete(id)
    else next.add(id)
    setUnticked(next)
  }

  return (
    <Dialog onClose={() => answer([])}>
      {(headingId) => (
        <>
          <h2 id={headingId} className={archive.heading}>
            {text.heading}
          </h2>
          <p className={archive.body}>{text.lead}</p>
          <div className={styles.list}>
            {stops.length > 1 && (
              <label className={styles.all}>
                <input
                  type="checkbox"
                  checked={picked.length === stops.length}
                  ref={(input) => {
                    if (input)
                      input.indeterminate = picked.length > 0 && picked.length < stops.length
                  }}
                  onChange={(event) =>
                    setUnticked(
                      event.target.checked ? new Set() : new Set(stops.map((task) => task.id)),
                    )
                  }
                />
                <span>Select all</span>
                <span className={styles.count}>
                  {`${picked.length} of ${stops.length} selected`}
                </span>
              </label>
            )}
            <ul className={styles.rows}>
              {stops.map((task) => {
                const about = (
                  <>
                    <span className={styles.id}>{task.displayId}</span>
                    <span className={styles.title}>{task.title}</span>
                    <span className={styles.stage}>{stageName(task.stage)}</span>
                  </>
                )
                return (
                  <li key={task.id}>
                    {stops.length > 1 ? (
                      <label className={styles.row}>
                        <input
                          type="checkbox"
                          checked={!unticked.has(task.id)}
                          onChange={(event) => toggle(task.id, event.target.checked)}
                        />
                        {about}
                      </label>
                    ) : (
                      <div className={styles.row}>{about}</div>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
          {text.note !== undefined && <p className={styles.note}>{text.note}</p>}
          {error !== undefined && (
            <p className={archive.error} role="alert">
              {error}
            </p>
          )}
          <div className={archive.buttons}>
            <Button disabled={busy} onClick={() => answer([])}>
              Leave stopped
            </Button>
            <Button
              variant="primary"
              disabled={busy || picked.length === 0}
              onClick={() => answer(picked.map((task) => task.id))}
            >
              {text.restart}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  )
}
