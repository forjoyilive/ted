import { type CheckRun, checkLabel } from '@ted/protocol/checks'
import { useEffect, useId, useRef, useState } from 'react'
import { readableError, ted } from '../ted.ts'
import styles from './CheckOutputDialog.module.css'
import { CloseIcon } from './icons.tsx'
import { Loading } from './Loading.tsx'

export function CheckOutputDialog({
  checkRun,
  position,
  onClose,
}: {
  checkRun: CheckRun
  position: number
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const headingId = useId()
  const [shown, setShown] = useState(position)
  const [output, setOutput] = useState<{ position: number; text: string; log: string }>()
  const [error, setError] = useState<string>()
  const check = checkRun.checks[shown]
  const running = check?.state === 'running'

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  useEffect(() => {
    let current = true
    const load = () =>
      ted.checkOutput(checkRun.id, shown).then(
        (loaded) => {
          if (current) setOutput({ position: shown, ...loaded })
        },
        (failure: unknown) => {
          if (current) setError(readableError(failure))
        },
      )
    setError(undefined)
    void load()
    const timer = running ? setInterval(() => void load(), 1000) : undefined
    return () => {
      current = false
      if (timer !== undefined) clearInterval(timer)
    }
  }, [checkRun.id, shown, running])

  const ran = checkRun.checks.flatMap((c, i) =>
    c.state === 'skipped' || c.state === 'not-run' || c.state === 'waiting' ? [] : [i],
  )
  const text = output?.position === shown ? output.text : undefined

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <header className={styles.head}>
        <h2 id={headingId} className={styles.heading}>
          {check ? checkLabel(check) : 'Check'} output
        </h2>
        <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      {ran.length > 1 && (
        <div className={styles.tabs} role="tablist" aria-label="Checks">
          {ran.map((i) => {
            const c = checkRun.checks[i]
            return (
              c && (
                <button
                  key={i}
                  type="button"
                  role="tab"
                  aria-selected={i === shown}
                  className={styles.tab}
                  onClick={() => setShown(i)}
                >
                  {checkLabel(c)}
                </button>
              )
            )
          })}
        </div>
      )}
      {check && <code className={styles.command}>{check.command}</code>}
      {error !== undefined ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : (
        <pre className={`${styles.output} ${text === undefined ? styles.pending : ''}`}>
          {text === undefined ? (
            <Loading terminal label="Loading Check output…" />
          ) : text === '' ? (
            'No output.'
          ) : (
            text
          )}
        </pre>
      )}
      {output?.position === shown && <p className={styles.log}>Full log: {output.log}</p>}
    </dialog>
  )
}
