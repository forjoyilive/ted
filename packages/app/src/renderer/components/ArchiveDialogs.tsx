import type { BlockedChoice, Task } from '@ted/protocol'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { useTaskRuns, useTasks } from '../data.ts'
import { stageName } from '../list-view.ts'
import { readableError, ted } from '../ted.ts'
import styles from './ArchiveDialogs.module.css'
import { Button } from './Button.tsx'
import { Help } from './Help.tsx'

export const archiveTaskEvent = 'ted:archive-task'

function joinAnd(items: readonly string[]): string {
  if (items.length < 2) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

function openPullRequests(task: Task) {
  return task.repos.flatMap((r) =>
    r.pullRequest && r.pullRequest.state !== 'closed' ? [{ repo: r, pr: r.pullRequest }] : [],
  )
}

function useBlocked(task: Task): Task[] {
  return useTasks().filter((t) => t.blockedBy.includes(task.id) && !t.archived)
}

function Dialog({
  children,
  onClose,
}: {
  children: (headingId: string) => ReactNode
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const headingId = useId()
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
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
      {children(headingId)}
    </dialog>
  )
}

function BlockedTasks({
  task,
  blocked,
  choice,
  ending,
  onChoose,
}: {
  task: Task
  blocked: readonly Task[]
  choice: BlockedChoice
  ending: 'archived' | 'deleted'
  onChoose: (choice: BlockedChoice) => void
}) {
  const name = useId()
  const one = blocked.length === 1
  const options: { value: BlockedChoice; label: string; help: string }[] = [
    {
      value: 'unblock',
      label: one ? 'Unblock it' : 'Unblock them',
      help: `Removes ${task.displayId} from ${one ? 'its' : 'their'} Blocked by, so ${one ? 'it' : 'they'} can start.`,
    },
    {
      value: 'keep',
      label: one ? 'Keep it blocked' : 'Keep them blocked',
      help: `${one ? 'It stays' : 'They stay'} blocked and ${one ? 'shows' : 'show'} “Blocked by ${ending} ${task.displayId}”.`,
    },
  ]
  return (
    <fieldset className={styles.blocked}>
      <legend className={styles.blockedHeading}>
        {`${blocked.length} ${one ? 'Task is' : 'Tasks are'} blocked by ${task.displayId}`}
      </legend>
      <ul className={styles.blockedList}>
        {blocked.map((t) => (
          <li key={t.id} className={styles.blockedRow}>
            <span className={styles.blockedId}>{t.displayId}</span>
            <span className={styles.blockedTitle}>{t.title}</span>
            <span className={styles.blockedStage}>{stageName(t.stage)}</span>
          </li>
        ))}
      </ul>
      {options.map((option) => (
        <label key={option.value} className={styles.radio}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={choice === option.value}
            onChange={() => onChoose(option.value)}
          />
          {option.label}
          <Help>{option.help}</Help>
        </label>
      ))}
    </fieldset>
  )
}

function runsPhrase(runs: number): string {
  if (runs === 1) return 'the Task Lead’s Run'
  return `its ${runs} Runs`
}

export function ArchiveDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const blocked = useBlocked(task)
  const prs = openPullRequests(task)
  const [close, setClose] = useState(true)
  const [choice, setChoice] = useState<BlockedChoice>('unblock')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const hasWorktree = task.repos.some((r) => !r.removed)
  const does = [
    ...(task.runs.length > 0 ? [`stops ${runsPhrase(task.runs.length)}`] : []),
    ...(hasWorktree ? ['removes the worktree'] : []),
  ]
  const action = does.length === 0 ? '' : ` TED ${does.join(' and ')}.`
  const kept =
    task.repos.length > 0
      ? 'Comments, the brief, Conversations and the branches are kept.'
      : 'Comments and the brief are kept.'

  async function archive() {
    setBusy(true)
    setError(undefined)
    try {
      await ted.archiveTask(task.id, {
        closePullRequests: prs.length > 0 && close,
        ...(blocked.length > 0 && { blocked: choice }),
      })
      onClose()
    } catch (failure) {
      setError(readableError(failure))
      setBusy(false)
    }
  }

  return (
    <Dialog onClose={onClose}>
      {(headingId) => (
        <>
          <h2 id={headingId} className={styles.heading}>{`Archive ${task.displayId}?`}</h2>
          <p className={styles.body}>
            {`${task.title}.${action} ${kept} You can unarchive it later.`}
          </p>
          {prs.length > 0 && (
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={close}
                onChange={(event) => setClose(event.target.checked)}
              />
              <span>
                Close the pull requests on GitHub
                <span className={styles.checkNote}>
                  {`${joinAnd(prs.map(({ repo, pr }) => `${repo.name} #${pr.number}`))}.`}
                  <Help>Unarchive reopens them if their branches still exist.</Help>
                </span>
              </span>
            </label>
          )}
          {blocked.length > 0 && (
            <BlockedTasks
              task={task}
              blocked={blocked}
              choice={choice}
              ending="archived"
              onChoose={setChoice}
            />
          )}
          {error !== undefined && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.buttons}>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={busy} onClick={() => void archive()}>
              Archive
            </Button>
          </div>
        </>
      )}
    </Dialog>
  )
}

export function DeleteDialog({
  task,
  onClose,
  onArchiveInstead,
}: {
  task: Task
  onClose: () => void
  onArchiveInstead: () => void
}) {
  const blocked = useBlocked(task)
  const runs = useTaskRuns(task.id).length
  const prs = openPullRequests(task)
  const [choice, setChoice] = useState<BlockedChoice>('unblock')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const removed = [
    'the Task',
    ...(runs > 0
      ? [
          `its ${runs === 1 ? 'Run with its Conversation' : `${runs} Runs with their Conversations`}`,
        ]
      : []),
    'its Comments',
    'its brief',
  ]

  async function remove() {
    setBusy(true)
    setError(undefined)
    try {
      await ted.deleteTask(task.id, blocked.length > 0 ? { blocked: choice } : {})
      onClose()
    } catch (failure) {
      setError(readableError(failure))
      setBusy(false)
    }
  }

  return (
    <Dialog onClose={onClose}>
      {(headingId) => (
        <>
          <h2 id={headingId} className={styles.heading}>{`Delete ${task.displayId}?`}</h2>
          <p className={styles.body}>
            {`${task.title}. TED removes ${joinAnd(removed)}. This can’t be undone.`}
          </p>
          {prs.length > 0 && (
            <p className={styles.warning}>
              {`${prs.length === 1 ? 'Pull request' : 'Pull requests'} ${joinAnd(prs.map(({ pr }) => `#${pr.number}`))} stay open on GitHub, and the ${prs.length === 1 ? 'branch stays' : 'branches stay'}.${task.archived ? '' : ' Archive closes the pull requests and keeps the history.'}`}
            </p>
          )}
          {blocked.length > 0 && (
            <BlockedTasks
              task={task}
              blocked={blocked}
              choice={choice}
              ending="deleted"
              onChoose={setChoice}
            />
          )}
          {error !== undefined && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.buttons}>
            {!task.archived && (
              <button type="button" className={styles.instead} onClick={onArchiveInstead}>
                Archive instead
              </button>
            )}
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>
              {busy ? 'Deleting…' : `Delete ${task.displayId}`}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  )
}
