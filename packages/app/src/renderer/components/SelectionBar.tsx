import type { AutopilotChoice, MachineSettings, RunSlots, Task } from '@ted/protocol'
import { priorities } from '@ted/protocol/task'
import { useEffect, useRef, useState } from 'react'
import { usePendingAction } from '../pending-action.ts'
import { startSplit, startWaitLine } from '../slots.ts'
import { statusAction } from '../task-actions.ts'
import { priorityLabels } from '../task-fields.ts'
import { readableError, ted } from '../ted.ts'
import styles from '../views/TaskList.module.css'
import { ActionButton } from './ActionButton.tsx'
import dialogStyles from './ArchiveDialogs.module.css'
import { Dialog } from './ArchiveDialogs.tsx'
import { Button } from './Button.tsx'
import { ContextMenu, MenuItems, type MenuPosition } from './ContextMenu.tsx'
import { PriorityIcon } from './PriorityIcon.tsx'
import { Select } from './Select.tsx'
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

const counted = (label: string, part: readonly Task[], all: readonly Task[]) =>
  part.length === all.length || part.length === 0 ? label : `${label} ${part.length}`

export function SelectionBar({
  scope,
  chosen,
  allTasks,
  slots,
  settings,
  onSelect,
}: {
  scope: string
  chosen: readonly Task[]
  allTasks: readonly Task[]
  slots: RunSlots | undefined
  settings: MachineSettings | undefined
  onSelect: (ids: string[]) => void
}) {
  const [autopilotBusy, setAutopilotBusy] = useState(false)
  const [autopilotResult, setAutopilotResult] = useState<string>()
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [prepareNotice, setPrepareNotice] = useState(false)
  const [noticeSeen, setNoticeSeen] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [prepareError, setPrepareError] = useState<string>()
  const [closePullRequests, setClosePullRequests] = useState(true)
  const [priorityOpen, setPriorityOpen] = useState(false)
  const [moreAt, setMoreAt] = useState<MenuPosition>()
  const moreWasOpen = useRef(false)
  const [snoozing, setSnoozing] = useState(false)
  const [deleting, setDeleting] = useState<'archive' | 'delete'>()

  const none = chosen.length === 0
  useEffect(() => {
    if (!none) return
    setConfirmArchive(false)
    setPriorityOpen(false)
    setMoreAt(undefined)
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

  const bulkActivity = usePendingAction(`bulk-tasks:${scope}`)
  async function setAutopilot(choice: AutopilotChoice) {
    const eligible = chosen.filter((t) => !t.archived && t.stage !== 'done')
    setAutopilotBusy(true)
    setAutopilotResult(undefined)
    const failed: string[] = []
    const errors: string[] = []
    try {
      for (const task of eligible) {
        try {
          await ted.setTaskAutopilot(task.id, { choice })
        } catch (error) {
          failed.push(task.id)
          errors.push(`${task.displayId}: ${readableError(error)}`)
        }
      }
      setAutopilotResult(
        `Updated ${eligible.length - failed.length} Tasks. ${chosen.length - eligible.length} finished or archived Tasks skipped.${errors.length ? ` ${errors.join(' · ')}` : ''}`,
      )
      if (failed.length) onSelect(failed)
    } finally {
      setAutopilotBusy(false)
    }
  }

  async function bulk(action: (task: Task) => Promise<unknown>, on: readonly Task[]) {
    return bulkActivity.run(() => Promise.all(on.map((task) => action(task).catch(report))))
  }

  async function prepareTasks() {
    setPreparing(true)
    setPrepareError(undefined)
    try {
      if (!settings?.preparationNoticeSeen && !noticeSeen) {
        await ted.updateSettings({ preparationNoticeSeen: true })
        setNoticeSeen(true)
      }
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
      else setPrepareNotice(false)
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
          <fieldset
            disabled={bulkActivity.pending || preparing || autopilotBusy}
            className={styles.selectionControls}
          >
            <span className={styles.selectionCount}>{chosen.length} selected</span>
            <Select
              aria-label="Autopilot for selected Tasks"
              value=""
              disabled={autopilotBusy || !chosen.some((t) => !t.archived && t.stage !== 'done')}
              onChange={(event) => {
                if (event.target.value) void setAutopilot(event.target.value as AutopilotChoice)
              }}
            >
              <option value="" disabled>
                {autopilotBusy ? 'Updating Autopilot…' : 'Autopilot…'}
              </option>
              <option value="on">Autopilot on</option>
              <option value="off">Autopilot off</option>
              <option value="inherit">Use global setting</option>
            </Select>
            <small>
              Turning on also handles waiting routine requests. Start and Resume stay separate.
            </small>
            <Button
              disabled={startable.length === 0}
              onClick={() => bulk((t) => ted.startTask(t.id), startable).catch(report)}
            >
              {counted('Start', startable, chosen)}
            </Button>
            <Button
              disabled={preparable.length === 0 || preparing}
              title="Runs through Design, then waits before Work. Resume or Autopilot lets it continue."
              onClick={() => {
                if (settings?.preparationNoticeSeen || noticeSeen) return prepareTasks()
                setNoticeSeen(true)
                setPrepareNotice(true)
                return ted
                  .updateSettings({ preparationNoticeSeen: true })
                  .catch((error: unknown) => setPrepareError(readableError(error)))
              }}
            >
              {counted('Prepare through Design', preparable, chosen)}
            </Button>
            {resumable.length > 0 && (
              <Button
                onClick={() => bulk((task) => ted.resumeTask(task.id), resumable).catch(report)}
              >
                {counted('Resume', resumable, chosen)}
              </Button>
            )}
            <div className={styles.menuAnchor}>
              <Button
                aria-haspopup="menu"
                aria-expanded={priorityOpen}
                onClick={() => setPriorityOpen((o) => !o)}
              >
                Priority
              </Button>
              {priorityOpen && (
                <div
                  className={`${styles.menu} ${styles.upward}`}
                  role="menu"
                  aria-label="Priority"
                >
                  {priorities.map((priority) => (
                    <ActionButton
                      key={priority}
                      type="button"
                      role="menuitem"
                      className={styles.menuItem}
                      onClick={() =>
                        bulk((t) => ted.setPriority(t.id, priority), archivable)
                          .then(() => setPriorityOpen(false))
                          .catch(report)
                      }
                    >
                      <PriorityIcon priority={priority} />
                      <span className={styles.menuLabel}>
                        {priority === 'none' ? 'No priority' : priorityLabels[priority]}
                      </span>
                    </ActionButton>
                  ))}
                </div>
              )}
            </div>
            <Button disabled={snoozable.length === 0} onClick={() => setSnoozing(true)}>
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
                variant="primary"
                onClick={() => {
                  const close = closePullRequests && openPullRequests.length > 0
                  return bulk(
                    (t) => ted.archiveTask(t.id, { closePullRequests: close }),
                    archivable,
                  )
                    .then(() => {
                      onSelect([])
                      setConfirmArchive(false)
                    })
                    .catch(report)
                }}
              >
                {`Archive ${archivable.length} ${archivable.length === 1 ? 'Task' : 'Tasks'}`}
              </Button>
            ) : (
              <Button disabled={archivable.length === 0} onClick={() => setConfirmArchive(true)}>
                Archive
              </Button>
            )}
            <Button
              aria-label="More actions"
              title="More actions"
              aria-haspopup="menu"
              aria-expanded={moreAt !== undefined}
              onPointerDown={() => {
                moreWasOpen.current = moreAt !== undefined
              }}
              onClick={(event) => {
                if (moreWasOpen.current) {
                  moreWasOpen.current = false
                  return
                }
                const box = event.currentTarget.getBoundingClientRect()
                setPriorityOpen(false)
                setMoreAt({ x: box.left, y: box.top - 48, trigger: event.currentTarget })
              }}
            >
              <MoreIcon />
            </Button>
            {waitLine !== undefined && (
              <span className={styles.selectionWait} role="status" data-wait-line>
                {waitLine}
              </span>
            )}
          </fieldset>
        </div>
      )}
      {moreAt && !none && (
        <ContextMenu at={moreAt} label="More actions" onClose={() => setMoreAt(undefined)}>
          <MenuItems
            items={[{ label: 'Delete…', danger: true, action: () => setDeleting('delete') }]}
            choose={(item) => {
              setMoreAt(undefined)
              item.action?.()
            }}
          />
        </ContextMenu>
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
      {autopilotResult && <p role="status">{autopilotResult}</p>}
      {prepareError && (
        <p role="alert" className={dialogStyles.error}>
          {prepareError}
        </p>
      )}
      {prepareNotice && (
        <Dialog onClose={() => !preparing && setPrepareNotice(false)}>
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
                or in bulk, or turn on Autopilot to let them continue.
              </p>
              {settings?.overnightMode && (
                <p className={dialogStyles.body}>
                  Autopilot is on, so these Tasks can continue into Work as soon as Design finishes.
                </p>
              )}
              <div className={dialogStyles.buttons}>
                <Button disabled={preparing} onClick={() => setPrepareNotice(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={preparing || preparable.length === 0}
                  onClick={() => prepareTasks()}
                >{`Prepare ${preparable.length} ${preparable.length === 1 ? 'Task' : 'Tasks'}`}</Button>
              </div>
            </>
          )}
        </Dialog>
      )}
    </>
  )
}
