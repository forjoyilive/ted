import type { Factory, FactoryRemoval } from '@ted/protocol'
import { useEffect, useId, useRef, useState } from 'react'
import { readableError, ted } from '../ted.ts'
import styles from './ArchiveDialogs.module.css'
import { Button } from './Button.tsx'
import own from './RemoveFactoryDialog.module.css'

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

function joinAnd(items: readonly string[]): string {
  if (items.length < 2) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

export function removalLines(summary: FactoryRemoval): string[] {
  const lines: string[] = []
  if (summary.runs > 0) lines.push(`Stops ${count(summary.runs, 'Run')}.`)
  lines.push(
    summary.tasks === 0
      ? 'Deletes the Factory from Ted. It has no Tasks.'
      : `Deletes ${count(summary.tasks, 'Task')} with their Comments, Runs and Conversations from Ted.`,
  )
  const clones =
    summary.clones.length === 0
      ? ''
      : `Ted’s ${summary.clones.length === 1 ? 'clone' : 'clones'} of ${joinAnd(summary.clones)}`
  const worktrees = summary.worktrees === 0 ? '' : count(summary.worktrees, 'worktree')
  if (worktrees !== '' && clones !== '') {
    lines.push(`Runs teardown, then deletes ${worktrees} and ${clones}.`)
  } else if (worktrees !== '') {
    lines.push(`Runs teardown, then deletes ${worktrees}.`)
  } else if (clones !== '') {
    lines.push(`Deletes ${clones}.`)
  }
  if (summary.sharedClones.length > 0) {
    lines.push(`Keeps the clone of ${joinAnd(summary.sharedClones)}, which another Factory uses.`)
  }
  const primary = summary.clones[0] ?? summary.sharedClones[0] ?? 'the repo'
  lines.push(
    `Keeps branches on GitHub and .ted/ in ${primary}. Adding the repo again uses .ted/, with the setup Task in Backlog.`,
  )
  return lines
}

export function RemoveFactoryDialog({
  factory,
  onClose,
  onRemoved,
}: {
  factory: Factory
  onClose: () => void
  onRemoved: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const headingId = useId()
  const keyId = useId()
  const [summary, setSummary] = useState<FactoryRemoval>()
  const [close, setClose] = useState(true)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    dialog.current?.showModal()
    ted
      .factoryRemoval(factory.id)
      .then(setSummary, (failure: unknown) => setError(readableError(failure)))
  }, [factory.id])

  async function remove() {
    setBusy(true)
    setError(undefined)
    try {
      await ted.removeFactory(factory.id, { key: typed, closePullRequests: close })
      onRemoved()
    } catch (failure) {
      setError(readableError(failure))
      setBusy(false)
    }
  }

  const prs = summary?.openPullRequests ?? 0
  const ready = summary !== undefined && typed === factory.key && !busy

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <div>
        <h2 id={headingId} className={styles.heading}>{`Remove Factory ${factory.name}?`}</h2>
        <p className={own.undo}>This can’t be undone.</p>
      </div>
      {summary ? (
        <ul className={own.lines}>
          {removalLines(summary).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : (
        error === undefined && <p className={styles.body}>Counting what this removes…</p>
      )}
      {prs > 0 && (
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={close}
            disabled={busy}
            onChange={(event) => setClose(event.target.checked)}
          />
          {`Close ${count(prs, 'open pull request')} on GitHub`}
        </label>
      )}
      <div className={own.field}>
        <label className={own.label} htmlFor={keyId}>
          {`Type ${factory.key} to confirm`}
        </label>
        <input
          id={keyId}
          className={own.input}
          value={typed}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && ready) remove()
          }}
        />
      </div>
      {error !== undefined && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.buttons}>
        <Button disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" disabled={!ready} onClick={() => remove()}>
          {busy ? 'Removing…' : 'Remove Factory'}
        </Button>
      </div>
    </dialog>
  )
}
