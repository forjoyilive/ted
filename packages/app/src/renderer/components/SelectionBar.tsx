import type { MachineSettings, RunSlots, Task } from '@ted/protocol'
import { priorities } from '@ted/protocol/task'
import { useEffect, useState } from 'react'
import { startSplit, startWaitLine } from '../slots.ts'
import { statusAction } from '../task-actions.ts'
import { priorityLabels } from '../task-fields.ts'
import { readableError, ted } from '../ted.ts'
import styles from '../views/TaskList.module.css'
import dialogStyles from './ArchiveDialogs.module.css'
import { Dialog } from './ArchiveDialogs.tsx'
import { Button } from './Button.tsx'
import { PriorityIcon } from './PriorityIcon.tsx'
import { SnoozeTaskDialog } from './SnoozeTaskDialog.tsx'
import { BulkConfirmDialog } from './TaskContextMenu.tsx'

function report(error: unknown) {
  console.error(error)
}

function MoreIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <circle cx="3" cy="7" r="1.2" fill="currentColor" />
      <circle cx="7" cy="7" r="1.2" fill="currentColor" />
      <circle cx="11" cy="7" r="1.2" fill="currentColor" />
    </svg>
  )
}

async function bulk(action: (task: Task) => Promise<unknown>, on: readonly Task[]) {
  await Promise.all(on.map((task) => action(task).catch(report)))
}

const counted = (label: string, part: readonly Task[], all: readonly Task[]) =>
  part.length === all.length || part.length === 0 ? label : `${label} ${part.length}`

export function SelectionBar({
  chosen,
  allTasks,
  slots,
  settings,
  onClear,
}: {
  chosen: readonly Task[]
  allTasks: readonly Task[]
  slots: RunSlots | undefined
  settings: MachineSettings | undefined
  onClear: () => void
}) {
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [prepareNotice, setPrepareNotice] = useState(false)
  const [noticeSeen, setNoticeSeen] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [prepareError, setPrepareError] = useState<string>()
  const [closePullRequests, setClosePullRequests] = useState(true)
  const [menu, setMenu] = useState<'priority' | 'more'>()
  const [snoozing, setSnoozing] = useState(false)
  const [deleting, setDeleting] = useState<'archive' | 'delete'>()

  const none = chosen.length === 0
  useEffect(() => {
    if (!none) return
    setConfirmArchive(false)
    setMenu(undefined)
  }, [none])

  const startable = chosen.filter((t) => t.stage === 'backlog' && !t.statuses.includes('blocked'))
  const preparable = startable.filter((t) => !t.archived && !t.setup)
  const resumable = chosen.filter((t) => statusAction(t)?.kind === 'resume')
  const archivable = chosen.filter((t) => !t.archived)
  const snoozable = archivable.filter((t) => t.stage === 'backlog' && !t.setup)
  const openPullRequests = archivable.flatMap((t) =>
    t.repos.flatMap((r) =>
      r.pullRequest && r.pullRequest.state !== 'closed' && r.pullRequest.state !== 'merged'
        ? [`${r.repo}#${r.pullRequest.number}`]
        : [],
    ),
  )
  const waitLine =
    slots && startable.length > 0 ? startWaitLine(startSplit(slots, startable)) : undefined

  async function prepareTasks() {
    setPreparing(true)
    setPrepareError(undefined)
    try {
      if (!settings?.preparationNoticeSeen && !noticeSeen) {
        await ted.updateSettings({ preparationNoticeSeen: true })
        setNoticeSeen(true)
      }
      setPrepareNotice(false)
      const failures = await Promise.all(
        preparable.map(async (task) => {
          try {
            await ted.startTask(task.id, { prepare: true })
            return undefined
          } catch (error) {
            return `${task.displayId}: ${readableError(error)}`
          }
        }),
      )
      const errors = failures.filter((error) => error !== undefined)
      if (errors.length > 0) setPrepareError(errors.join('\n'))
    } catch (error) {
      setPrepareError(readableError(error))
    } finally {
      setPreparing(false)
    }
  }

  return (
    <>
      {!none && (
        <div className={styles.selectionBar} role="toolbar" aria-label="Selected Tasks">
          <span className={styles.selectionCount}>{chosen.length} selected</span>
          <Button
            size="small"
            disabled={startable.length === 0}
            onClick={() => bulk((t) => ted.startTask(t.id), startable).catch(report)}
          >
            {counted('Start', startable, chosen)}
          </Button>
          <Button
            size="small"
            disabled={preparable.length === 0 || preparing}
            title="Runs through Design, then waits before Work. Resume or Overnight mode lets it continue."
            onClick={() => {
              if (settings?.preparationNoticeSeen || noticeSeen) void prepareTasks()
              else {
                setNoticeSeen(true)
                setPrepareNotice(true)
                ted
                  .updateSettings({ preparationNoticeSeen: true })
                  .catch((error: unknown) => setPrepareError(readableError(error)))
              }
            }}
          >
            {counted('Prepare through Design', preparable, chosen)}
          </Button>
          {resumable.length > 0 && (
            <Button
              size="small"
              onClick={() => bulk((task) => ted.resumeTask(task.id), resumable).catch(report)}
            >
              {counted('Resume', resumable, chosen)}
            </Button>
          )}
          <div className={styles.menuAnchor}>
            <Button
              size="small"
              aria-haspopup="menu"
              aria-expanded={menu === 'priority'}
              onClick={() => setMenu((m) => (m === 'priority' ? undefined : 'priority'))}
            >
              Priority
            </Button>
            {menu === 'priority' && (
              <div className={`${styles.menu} ${styles.upward}`} role="menu" aria-label="Priority">
                {priorities.map((priority) => (
                  <button
                    key={priority}
                    type="button"
                    role="menuitem"
                    className={styles.menuItem}
                    onClick={() => {
                      setMenu(undefined)
                      bulk((t) => ted.setPriority(t.id, priority), archivable).catch(report)
                    }}
                  >
                    <PriorityIcon priority={priority} />
                    <span className={styles.menuLabel}>
                      {priority === 'none' ? 'No priority' : priorityLabels[priority]}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <Button size="small" disabled={snoozable.length === 0} onClick={() => setSnoozing(true)}>
            {counted('Snooze', snoozable, chosen)}
          </Button>
          {confirmArchive && openPullRequests.length > 0 && (
            <label className={styles.closePullRequests} title={openPullRequests.join(', ')}>
              <input
                type="checkbox"
                checked={closePullRequests}
                onChange={(event) => setClosePullRequests(event.target.checked)}
              />
              {`Close ${openPullRequests.length === 1 ? 'the pull request' : `${openPullRequests.length} pull requests`} on GitHub`}
            </label>
          )}
          {confirmArchive ? (
            <Button
              size="small"
              variant="primary"
              onClick={() => {
                setConfirmArchive(false)
                const close = closePullRequests && openPullRequests.length > 0
                bulk((t) => ted.archiveTask(t.id, { closePullRequests: close }), archivable)
                  .then(onClear)
                  .catch(report)
              }}
            >
              {`Archive ${archivable.length} ${archivable.length === 1 ? 'Task' : 'Tasks'}`}
            </Button>
          ) : (
            <Button
              size="small"
              disabled={archivable.length === 0}
              onClick={() => setConfirmArchive(true)}
            >
              Archive
            </Button>
          )}
          <div className={styles.menuAnchor}>
            <Button
              size="small"
              aria-label="More actions"
              title="More actions"
              aria-haspopup="menu"
              aria-expanded={menu === 'more'}
              onClick={() => setMenu((m) => (m === 'more' ? undefined : 'more'))}
            >
              <MoreIcon />
            </Button>
            {menu === 'more' && (
              <div
                className={`${styles.menu} ${styles.upward} ${styles.moreMenu}`}
                role="menu"
                aria-label="More actions"
              >
                <button
                  type="button"
                  role="menuitem"
                  className={`${styles.menuItem} ${styles.dangerItem}`}
                  onClick={() => {
                    setMenu(undefined)
                    setDeleting('delete')
                  }}
                >
                  <span className={styles.menuLabel}>Delete…</span>
                </button>
              </div>
            )}
          </div>
          {waitLine !== undefined && (
            <span className={styles.selectionWait} role="status">
              {waitLine}
            </span>
          )}
        </div>
      )}
      {snoozing && snoozable[0] && (
        <SnoozeTaskDialog
          task={snoozable[0]}
          tasks={snoozable}
          onClose={() => setSnoozing(false)}
        />
      )}
      {deleting && !none && (
        <BulkConfirmDialog
          tasks={chosen}
          allTasks={allTasks}
          kind={deleting}
          onKind={setDeleting}
        />
      )}
      {prepareError && (
        <p role="alert" className={dialogStyles.error}>
          {prepareError}
        </p>
      )}
      {prepareNotice && (
        <Dialog onClose={() => setPrepareNotice(false)}>
          {(headingId) => (
            <>
              <h2 id={headingId} className={dialogStyles.heading}>
                Prepare through Design
              </h2>
              <p className={dialogStyles.body}>
                Settle questions and review designs now. Each Task enters Work and waits before
                implementation starts.
              </p>
              <p className={dialogStyles.body}>
                Answer questions and approve sign-offs as usual. Resume prepared Tasks individually
                or in bulk, or turn on Overnight mode to let them continue.
              </p>
              {settings?.overnightMode && (
                <p className={dialogStyles.body}>
                  Overnight mode is on, so these Tasks can continue into Work as soon as Design
                  finishes.
                </p>
              )}
              <div className={dialogStyles.buttons}>
                <Button onClick={() => setPrepareNotice(false)}>Cancel</Button>
                <Button
                  variant="primary"
                  disabled={preparing || preparable.length === 0}
                  onClick={() => void prepareTasks()}
                >{`Prepare ${preparable.length} ${preparable.length === 1 ? 'Task' : 'Tasks'}`}</Button>
              </div>
            </>
          )}
        </Dialog>
      )}
    </>
  )
}
