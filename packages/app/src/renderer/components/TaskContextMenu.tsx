import type { Task } from '@ted/protocol'
import { agentKinds } from '@ted/protocol/run'
import { clarifyDepths, clarifyIsOver, priorities } from '@ted/protocol/task'
import { useEffect, useState } from 'react'
import { runStatusAction, statusAction } from '../task-actions.ts'
import { agentLabels, clarifyDepthLabels, priorityLabels } from '../task-fields.ts'
import { readableError, ted } from '../ted.ts'
import { useEnabledAgents } from './AgentOptions.tsx'
import dialogStyles from './ArchiveDialogs.module.css'
import { Dialog } from './ArchiveDialogs.tsx'
import { Button } from './Button.tsx'
import menuStyles from './ContextMenu.module.css'
import { ContextMenu, type MenuAction, MenuItems, type MenuPosition } from './ContextMenu.tsx'
import { SnoozeTaskDialog } from './SnoozeTaskDialog.tsx'
import { TaskActionsMenu } from './TaskActions.tsx'

const taskMenuEvent = 'ted:task-context-menu'
interface TaskMenuRequest {
  ids: string[]
  at: MenuPosition
}

export function openTaskActions(at: MenuPosition, ids: string[]) {
  window.dispatchEvent(new CustomEvent<TaskMenuRequest>(taskMenuEvent, { detail: { ids, at } }))
}

function BulkTaskMenu({
  tasks,
  allTasks,
  at,
  onClose,
}: {
  tasks: Task[]
  allTasks: readonly Task[]
  at: MenuPosition | undefined
  onClose: () => void
}) {
  const enabledAgents = useEnabledAgents()
  const [snoozing, setSnoozing] = useState(false)
  const [confirmation, setConfirmation] = useState<'archive' | 'delete'>()
  const [closePullRequests, setClosePullRequests] = useState(true)
  const [blocked, setBlocked] = useState<'unblock' | 'keep'>('unblock')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const active = tasks.every((task) => !task.archived)
  const archived = tasks.every((task) => task.archived)
  const current = tasks.map(statusAction)
  const action = current[0]
  const common =
    action && action.kind !== 'follow-up' && current.every((a) => a?.kind === action.kind)
  const items: MenuAction[] = []
  const each = async (work: (task: Task) => Promise<unknown>) => {
    for (const task of tasks) {
      try {
        await work(task)
      } catch (failure) {
        throw new Error(
          `${task.displayId}: ${readableError(failure)} Some selected Tasks may already have changed.`,
        )
      }
    }
  }
  if (common)
    items.push({ label: action.label, action: () => each((t) => runStatusAction(action.kind, t)) })
  if (active && tasks.every((t) => t.preparation === 'ready'))
    items.push({ label: 'Stop Task', action: () => each((t) => ted.stopTask(t.id)) })
  const leads = tasks.map((t) =>
    t.runs.find((run) => run.id === t.leadRunId && run.role === 'lead'),
  )
  if (active && leads.every((lead) => lead !== undefined && lead.state !== 'finished'))
    items.push({
      label: 'Restart',
      disabled: leads.some((lead) => lead?.state === 'working'),
      action: () =>
        each((task) => {
          const lead = task.runs.find((run) => run.id === task.leadRunId && run.role === 'lead')
          if (!lead) throw new Error('No Task Lead Run is available to restart.')
          return ted.restartRun(lead.id)
        }),
    })
  if (active && tasks.every((t) => t.stage === 'backlog' && !t.setup)) {
    items.push({ label: 'Snooze…', action: () => setSnoozing(true) })
    if (tasks.every((t) => t.snoozedUntil))
      items.push({
        label: 'Cancel snooze',
        action: () => each((t) => ted.setTaskSnooze(t.id, null)),
      })
  }
  if (active && tasks.every((t) => t.source?.linear && t.linearSync === 'ask'))
    items.push({ label: 'Sync with Linear', action: () => each((t) => ted.allowLinearSync(t.id)) })
  if (active) {
    items.push({
      label: 'Priority',
      items: priorities.map((priority) => ({
        label: priority === 'none' ? 'No priority' : priorityLabels[priority],
        action: () => each((t) => ted.setPriority(t.id, priority)),
      })),
    })
    if (tasks.every((t) => t.stage !== 'done'))
      items.push({
        label: 'Task Lead',
        items: agentKinds
          .filter(
            (agent) =>
              enabledAgents.includes(agent) || tasks.every((task) => task.lead?.agent === agent),
          )
          .map((agent) => ({
            label: `${agentLabels[agent]}${enabledAgents.includes(agent) ? '' : ' · Off — new Runs wait'}`,
            disabled: !enabledAgents.includes(agent),
            action: () =>
              each((t) =>
                t.lead?.agent === agent ? Promise.resolve() : ted.setTaskLead(t.id, { agent }),
              ),
          })),
      })
    if (tasks.every((t) => !clarifyIsOver(t.stage)))
      items.push({
        label: 'Clarify depth',
        items: clarifyDepths.map((depth) => ({
          label: clarifyDepthLabels[depth],
          action: () => each((t) => ted.setClarifyDepth(t.id, { depth })),
        })),
      })
  }
  items.push({
    label: 'Copy Task IDs',
    action: () => navigator.clipboard.writeText(tasks.map((t) => t.displayId).join('\n')),
  })
  if (archived)
    items.push({ label: 'Unarchive', action: () => each((t) => ted.unarchiveTask(t.id)) })
  if (active) items.push({ label: 'Archive…', action: () => setConfirmation('archive') })
  items.push({ label: 'Delete…', danger: true, action: () => setConfirmation('delete') })
  const dependents = allTasks.filter(
    (t) => !t.archived && t.blockedBy.some((id) => tasks.some((chosen) => chosen.id === id)),
  )
  const pullRequests = tasks.flatMap((t) =>
    t.repos.flatMap((r) =>
      r.pullRequest && !['closed', 'merged'].includes(r.pullRequest.state)
        ? [r.pullRequest.url]
        : [],
    ),
  )
  const perform = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await each((t) =>
        confirmation === 'archive'
          ? ted.archiveTask(t.id, {
              closePullRequests: closePullRequests && pullRequests.length > 0,
              blocked,
            })
          : ted.deleteTask(t.id, { blocked }),
      )
      setConfirmation(undefined)
    } catch (failure) {
      setError(readableError(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {at && (
        <ContextMenu at={at} label={`${tasks.length} selected Tasks`} onClose={onClose}>
          <MenuItems
            items={items}
            choose={(item) => {
              onClose()
              setError(undefined)
              Promise.resolve()
                .then(() => item.action?.())
                .catch((failure: unknown) => setError(readableError(failure)))
            }}
          />
        </ContextMenu>
      )}
      {snoozing && tasks[0] && (
        <SnoozeTaskDialog task={tasks[0]} tasks={tasks} onClose={() => setSnoozing(false)} />
      )}
      {error && !confirmation && (
        <p className={menuStyles.error} role="alert">
          {error}
        </p>
      )}
      {confirmation && (
        <Dialog
          onClose={() => {
            if (!busy) setConfirmation(undefined)
          }}
        >
          {(headingId) => (
            <>
              <h2 id={headingId} className={dialogStyles.heading}>
                {confirmation === 'archive' ? 'Archive' : 'Delete'} {tasks.length} Tasks?
              </h2>
              <p className={dialogStyles.body}>{tasks.map((t) => t.displayId).join(', ')}</p>
              {error && (
                <p role="alert" className={dialogStyles.error}>
                  {error}
                </p>
              )}
              <p className={dialogStyles.body}>
                {confirmation === 'delete'
                  ? 'This removes the selected Tasks, their Runs and Conversations, Comments and briefs. This can’t be undone. Pull requests and branches stay on GitHub.'
                  : 'This stops their Runs and Apps and removes their worktrees. Their history stays in TED.'}
              </p>
              {confirmation === 'archive' && pullRequests.length > 0 && (
                <label className={dialogStyles.body}>
                  <input
                    type="checkbox"
                    checked={closePullRequests}
                    onChange={(event) => setClosePullRequests(event.target.checked)}
                  />
                  Close {pullRequests.length} open pull requests on GitHub
                </label>
              )}
              {dependents.length > 0 && (
                <fieldset className={dialogStyles.body}>
                  <legend>{dependents.length} Tasks depend on the selected Tasks</legend>
                  <p>{dependents.map((t) => t.displayId).join(', ')}</p>
                  <label>
                    <input
                      type="radio"
                      checked={blocked === 'unblock'}
                      onChange={() => setBlocked('unblock')}
                    />
                    Unblock them
                  </label>
                  <label>
                    <input
                      type="radio"
                      checked={blocked === 'keep'}
                      onChange={() => setBlocked('keep')}
                    />
                    Keep them blocked
                  </label>
                </fieldset>
              )}
              <div className={dialogStyles.buttons}>
                <Button disabled={busy} onClick={() => setConfirmation(undefined)}>
                  Cancel
                </Button>
                {confirmation === 'delete' && active && (
                  <Button disabled={busy} onClick={() => setConfirmation('archive')}>
                    Archive instead
                  </Button>
                )}
                <Button
                  disabled={busy}
                  variant={confirmation === 'delete' ? 'danger' : 'primary'}
                  onClick={() => void perform()}
                >
                  {confirmation === 'archive' ? 'Archive' : 'Delete'} {tasks.length} Tasks
                </Button>
              </div>
            </>
          )}
        </Dialog>
      )}
    </>
  )
}

export function TaskContextMenu({
  tasks,
  place,
  onFollowedUp,
  onPickBlocker,
}: {
  tasks: readonly Task[]
  place: string
  onFollowedUp: (task: Task) => void
  onPickBlocker: (task: Task) => void
}) {
  const [request, setRequest] = useState<TaskMenuRequest>()
  const [at, setAt] = useState<MenuPosition>()
  useEffect(() => {
    const open = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      const next = event.detail as TaskMenuRequest
      setRequest(next)
      setAt(next.at)
    }
    window.addEventListener(taskMenuEvent, open)
    return () => window.removeEventListener(taskMenuEvent, open)
  }, [])
  useEffect(() => {
    void place
    setRequest(undefined)
    setAt(undefined)
  }, [place])
  const targets = request?.ids.flatMap((id) => tasks.find((t) => t.id === id) ?? []) ?? []
  if (!request || targets.length === 0) return null
  const close = () => setAt(undefined)
  if (request.ids.length > 1)
    return (
      <BulkTaskMenu
        key={request.ids.join(',')}
        tasks={targets}
        allTasks={tasks}
        at={at}
        onClose={close}
      />
    )
  const target = targets[0]
  if (!target) return null
  return (
    <TaskActionsMenu
      key={target.id}
      task={target}
      contextAt={at}
      contextOnly
      onMenuClose={close}
      onFollowedUp={onFollowedUp}
      onPickBlocker={onPickBlocker}
    />
  )
}
