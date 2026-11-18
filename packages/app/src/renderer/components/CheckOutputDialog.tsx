import type { FailureCase } from '@ted/protocol'
import { type CheckRun, checkLabel } from '@ted/protocol/checks'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useFailures } from '../data.ts'
import { readableError, ted } from '../ted.ts'
import styles from './CheckOutputDialog.module.css'
import { FailureDetails } from './FailureDetails.tsx'
import { CloseIcon } from './icons.tsx'
import { Loading } from './Loading.tsx'

const followSlack = 24

interface CheckOutputProps {
  checkRun: CheckRun
  position: number
  onClose: () => void
  failures?: readonly FailureCase[] | undefined
}

export function CheckOutputDialog(props: CheckOutputProps) {
  return props.failures ? (
    <RecordedCheckOutput {...props} failures={props.failures} />
  ) : (
    <CurrentCheckOutput {...props} />
  )
}

function CurrentCheckOutput(props: CheckOutputProps) {
  const failures = useFailures(props.checkRun.taskId)
  return <RecordedCheckOutput {...props} failures={failures} />
}

function RecordedCheckOutput({
  checkRun,
  position,
  onClose,
  failures,
}: CheckOutputProps & { failures: readonly FailureCase[] }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const headingId = useId()
  const [shown, setShown] = useState(position)
  const [output, setOutput] = useState<{ position: number; text: string; log: string }>()
  const [error, setError] = useState<string>()
  const pre = useRef<HTMLPreElement>(null)
  const following = useRef(true)
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

  useLayoutEffect(() => {
    const element = pre.current
    if (text !== undefined && element && following.current) element.scrollTop = element.scrollHeight
  }, [text])

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
          {check ? checkLabel(check) : 'Check'}{' '}
          {check?.instruction === undefined ? 'output' : 'report'}
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
                  onClick={() => {
                    following.current = true
                    setShown(i)
                  }}
                >
                  {checkLabel(c)}
                </button>
              )
            )
          })}
        </div>
      )}
      {failures
        .filter(
          (f) =>
            (f.source.kind === 'factory-check' || f.source.kind === 'post-rebase-check') &&
            f.source.checkRunId === checkRun.id &&
            f.source.position === shown,
        )
        .map((f) => (
          <FailureDetails key={f.id} failure={f} />
        ))}
      {check?.command !== undefined && <code className={styles.command}>{check.command}</code>}
      {error !== undefined ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : (
        <pre
          ref={pre}
          className={`${styles.output} ${text === undefined ? styles.pending : ''}`}
          onScroll={(event) => {
            const element = event.currentTarget
            following.current =
              element.scrollHeight - element.scrollTop - element.clientHeight <= followSlack
          }}
        >
          {text === undefined ? (
            <Loading terminal label="Loading check output…" />
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
