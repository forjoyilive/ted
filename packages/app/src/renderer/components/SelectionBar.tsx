import type { AutopilotChoice, MachineSettings, RunSlots, Task } from '@ted/protocol'
import { priorities } from '@ted/protocol/task'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { usePendingAction } from '../pending-action.ts'
import { startSplit, startWaitLine } from '../slots.ts'
import { statusAction } from '../task-actions.ts'
import { priorityLabels } from '../task-fields.ts'
import { readableError, ted } from '../ted.ts'
import styles from '../views/TaskList.module.css'
import dialogStyles from './ArchiveDialogs.module.css'
import { Dialog } from './ArchiveDialogs.tsx'
import { Button } from './Button.tsx'
import { ContextMenu, MenuItems, type MenuPosition } from './ContextMenu.tsx'
import { Select } from './Select.tsx'
import { SnoozeTaskDialog } from './SnoozeTaskDialog.tsx'
import { BulkConfirmDialog } from './TaskContextMenu.tsx'

function report(error: unknown) {
  console.error(error)
}

const archiveBatchSize = 8

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

export function startResumeLabel(
  startable: readonly Task[],
  resumable: readonly Task[],
  all: readonly Task[],
) {
  if (startable.length > 0 && resumable.length > 0)
    return `Start ${startable.length} · Resume ${resumable.length}`
  if (resumable.length > 0) return counted('Resume', resumable, all)
  return counted('Start', startable, all)
}

function startResumeTitle(startable: readonly Task[], resumable: readonly Task[]) {
  const tasks = (n: number, kind: string) => `${n} ${kind}${n === 1 ? '' : 's'}`
  const parts = [
    startable.length > 0 ? `starts ${tasks(startable.length, 'Backlog Task')}` : '',
    resumable.length > 0 ? `resumes ${tasks(resumable.length, 'stopped or prepared Task')}` : '',
  ].filter(Boolean)
  const text = parts.join(' and ')
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`
}

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
  const [moreAt, setMoreAt] = useState<MenuPosition>()
  const moreWasOpen = useRef(false)
  useLayoutEffect(() => {
    if (!moreAt) return
    const menu = document.querySelector('[role="menu"][aria-label="More actions"]')
    if (!menu) return
    const y = moreAt.trigger.getBoundingClientRect().top - menu.getBoundingClientRect().height - 6
    if (Math.abs(y - moreAt.y) >= 1) setMoreAt({ ...moreAt, y })
  }, [moreAt])
  const [snoozing, setSnoozing] = useState(false)
  const [deleting, setDeleting] = useState<'archive' | 'delete'>()

  const none = chosen.length === 0
  useEffect(() => {
    if (!none) return
    setConfirmArchive(false)
    setMoreAt(undefined)
    setAutopilotResult(undefined)
    setPrepareError(undefined)
  }, [none])

  const startable = chosen.filter((t) => t.stage === 'backlog' && !t.statuses.includes('blocked'))
  const preparable = startable.filter((t) => !t.archived && !t.setup)
  const resumable = chosen.filter(
    (t) => statusAction(t)?.kind === 'resume' && !startable.includes(t),
  )
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

  async function archiveSelection() {
    const close = closePullRequests && openPullRequests.length > 0
    await bulkActivity.run(async () => {
      for (let start = 0; start < archivable.length; start += archiveBatchSize) {
        const batch = archivable.slice(start, start + archiveBatchSize)
        await Promise.all(
          batch.map((task) => ted.archiveTask(task.id, { closePullRequests: close }).catch(report)),
        )
      }
      onSelect([])
      setConfirmArchive(false)
    })
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
            {(startable.length > 0 || resumable.length > 0) && (
              <Button
                variant="primary"
                title={startResumeTitle(startable, resumable)}
                onClick={() =>
                  bulk(
                    (t) => (startable.includes(t) ? ted.startTask(t.id) : ted.resumeTask(t.id)),
                    [...startable, ...resumable],
                  ).catch(report)
                }
              >
                {startResumeLabel(startable, resumable, chosen)}
              </Button>
            )}
            {preparable.length > 0 && (
              <Button
                disabled={preparing}
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
                {counted('Prepare', preparable, chosen)}
              </Button>
            )}
            {chosen.some((t) => !t.archived && t.stage !== 'done') && (
              <Select
                aria-label="Autopilot for selected Tasks"
                title="Autopilot makes routine decisions and carries started work through Merge. Turning it on also handles requests already waiting."
                value=""
                disabled={autopilotBusy}
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
            )}
            {confirmArchive ? (
              <>
                <Button variant="primary" onClick={() => archiveSelection().catch(report)}>
                  {`Archive ${archivable.length} ${archivable.length === 1 ? 'Task' : 'Tasks'}`}
                </Button>
                <Button onClick={() => setConfirmArchive(false)}>Cancel</Button>
              </>
            ) : (
              archivable.length > 0 && (
                <Button onClick={() => setConfirmArchive(true)}>Archive…</Button>
              )
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
                setMoreAt({ x: box.left, y: box.top - 86, trigger: event.currentTarget })
              }}
            >
              <MoreIcon />
            </Button>
            {confirmArchive && openPullRequests.length > 0 && (
              <label className={styles.selectionNote} title={openPullRequests.join(', ')}>
                <input
                  type="checkbox"
                  checked={closePullRequests}
                  onChange={(event) => setClosePullRequests(event.target.checked)}
                />
                {`Close ${openPullRequests.length === 1 ? 'the pull request' : `${openPullRequests.length} pull requests`} on GitHub`}
              </label>
            )}
            {waitLine !== undefined && (
              <span className={styles.selectionNote} role="status" data-wait-line>
                {waitLine}
              </span>
            )}
          </fieldset>
          {autopilotResult && (
            <p className={styles.selectionNote} role="status">
              {autopilotResult}
              <Button size="small" variant="quiet" onClick={() => setAutopilotResult(undefined)}>
                Dismiss
              </Button>
            </p>
          )}
          {prepareError && (
            <p className={`${styles.selectionNote} ${styles.selectionAlert}`} role="alert">
              {prepareError}
              <Button size="small" variant="quiet" onClick={() => setPrepareError(undefined)}>
                Dismiss
              </Button>
            </p>
          )}
        </div>
      )}
      {moreAt && !none && (
        <ContextMenu at={moreAt} label="More actions" onClose={() => setMoreAt(undefined)}>
          <MenuItems
            items={[
              ...(archivable.length > 0
                ? [
                    {
                      label: 'Priority',
                      items: priorities.map((priority) => ({
                        label: priority === 'none' ? 'No priority' : priorityLabels[priority],
                        action: () => bulk((t) => ted.setPriority(t.id, priority), archivable),
                      })),
                    },
                  ]
                : []),
              ...(snoozable.length > 0
                ? [
                    {
                      label: `${counted('Snooze', snoozable, chosen)}…`,
                      action: () => setSnoozing(true),
                    },
                  ]
                : []),
              { label: 'Delete…', danger: true, action: () => setDeleting('delete') },
            ]}
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
