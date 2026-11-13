import type { RunSummary, Task } from '@ted/protocol'
import { agentKinds } from '@ted/protocol/run'
import { clarifyDepths, clarifyIsOver, priorities, resetRefusal } from '@ted/protocol/task'
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTasks } from '../data.ts'
import { newChildTask, pickChildEvent, pickParentEvent } from '../hierarchy.ts'
import { keysFor } from '../keymap.ts'
import { besideMenu } from '../menu-tooltip.ts'
import { usePendingAction } from '../pending-action.ts'
import { clockTime } from '../requests.ts'
import { runStatusAction, type StatusAction, statusAction } from '../task-actions.ts'
import { agentLabels, clarifyDepthLabels, leadSummary, priorityLabels } from '../task-fields.ts'
import { readableError, ted } from '../ted.ts'
import { formatDate } from '../time.ts'
import { EditTaskDialog, editTaskEvent } from '../views/EditTaskDialog.tsx'
import { ActionButton } from './ActionButton.tsx'
import { useEnabledAgents } from './AgentOptions.tsx'
import {
  ArchiveDialog,
  archiveTaskEvent,
  DeleteDialog,
  deleteTaskEvent,
  FollowUpDialog,
  followUpTaskEvent,
  needsUnarchiveDialog,
  ResetDialog,
  resetTaskEvent,
  UnarchiveDialog,
  unarchiveTaskEvent,
} from './ArchiveDialogs.tsx'
import menuStyles from './ContextMenu.module.css'
import { buttonPosition, ContextMenu, type MenuPosition, MenuSubmenu } from './ContextMenu.tsx'
import { Tooltip } from './Help.tsx'
import { changeParent } from './HierarchySection.tsx'
import { LoadingError } from './Loading.tsx'
import { SnoozeTaskDialog, snoozeTaskEvent } from './SnoozeTaskDialog.tsx'
import styles from './TaskActions.module.css'

export const pickBlockerEvent = 'ted:pick-blocker'

function MoreIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <circle cx="3" cy="7" r="1.2" fill="currentColor" />
      <circle cx="7" cy="7" r="1.2" fill="currentColor" />
      <circle cx="11" cy="7" r="1.2" fill="currentColor" />
    </svg>
  )
}

function FirstItem({ action, onChoose }: { action: StatusAction; onChoose: () => void }) {
  const [hover, setHover] = useState(false)
  const id = useId()
  const button = useRef<HTMLButtonElement>(null)
  const tip = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const item = button.current
    const bubble = tip.current
    const menu = item?.closest('[role="menu"]')
    if (!hover || !item || !bubble || !menu) return
    const place = () => {
      const { left, top } = besideMenu(
        item.getBoundingClientRect(),
        menu.getBoundingClientRect(),
        bubble.getBoundingClientRect(),
        { width: window.innerWidth, height: window.innerHeight },
      )
      bubble.style.left = `${left}px`
      bubble.style.top = `${top}px`
    }
    place()
    menu.addEventListener('scroll', place)
    return () => menu.removeEventListener('scroll', place)
  }, [hover])
  return (
    <div className={styles.first}>
      <ActionButton
        ref={button}
        type="button"
        role="menuitem"
        className={styles.item}
        aria-describedby={id}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onBlur={() => setHover(false)}
        onClick={onChoose}
      >
        <span className={styles.label}>
          {action.label}
          <span className={styles.helpMark} aria-hidden>
            ?
          </span>
        </span>
        {action.kind !== 'stop' &&
          action.kind !== 'move-to-backlog' &&
          action.kind !== 'follow-up' && (
            <span className={styles.hint}>{keysFor('status').join(' or ')}</span>
          )}
      </ActionButton>
      {hover ? (
        createPortal(
          <Tooltip ref={tip} id={id} className={styles.tooltip}>
            {action.help}
          </Tooltip>,
          document.body,
        )
      ) : (
        <span id={id} hidden>
          {action.help}
        </span>
      )}
    </div>
  )
}

function Submenu({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <MenuSubmenu label={label} hint={hint}>
      {children}
    </MenuSubmenu>
  )
}

function Choice({
  label,
  checked,
  onChoose,
  disabled,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onChoose: () => void
}) {
  return (
    <ActionButton
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      disabled={disabled}
      className={styles.item}
      onClick={onChoose}
    >
      <span className={styles.tick} aria-hidden>
        {checked ? '✓' : ''}
      </span>
      <span className={styles.label}>{label}</span>
    </ActionButton>
  )
}

export interface TaskHistory {
  earlier: readonly RunSummary[]
  finished: readonly RunSummary[]
  loading: boolean
  error: string | undefined
  retry: () => void
  onOpen: (runId: string) => void
}

export interface TaskSideChat {
  available: boolean
  onOpen: () => void
}

function HistoryItem({ history, close }: { history: TaskHistory; close: () => void }) {
  const count = history.earlier.length + history.finished.length
  if (count === 0 && !history.loading && history.error === undefined) {
    return (
      <ActionButton
        type="button"
        role="menuitem"
        className={styles.item}
        aria-disabled
        title="No earlier conversations or finished sub-agents yet."
      >
        <span className={styles.label}>History</span>
        <span className={styles.hint}>Nothing yet</span>
      </ActionButton>
    )
  }
  const rows = (list: readonly RunSummary[]) =>
    list.map((run) => (
      <ActionButton
        key={run.id}
        type="button"
        role="menuitem"
        className={`${styles.item} ${styles.historyRow}`}
        onClick={() => {
          close()
          history.onOpen(run.id)
        }}
      >
        <span>{run.role === 'lead' ? 'Earlier conversation' : run.name}</span>
        <small>
          {formatDate(run.startedAt, { day: 'numeric', month: 'short', year: 'numeric' })} ·{' '}
          {clockTime(run.startedAt)} · {agentLabels[run.agent]}
        </small>
      </ActionButton>
    ))
  return (
    <MenuSubmenu label={count > 0 ? `History · ${count}` : 'History'}>
      {history.error !== undefined && <LoadingError error={history.error} retry={history.retry} />}
      {history.loading && <p className={styles.note}>Loading history…</p>}
      {history.earlier.length > 0 && (
        <>
          <div className={styles.group}>Earlier conversations</div>
          {rows(history.earlier)}
        </>
      )}
      {history.finished.length > 0 && (
        <>
          <div className={styles.group}>Finished sub-agents</div>
          {rows(history.finished)}
        </>
      )}
    </MenuSubmenu>
  )
}

export type TaskDialogKind =
  | 'archive'
  | 'delete'
  | 'edit'
  | 'follow-up'
  | 'reset'
  | 'snooze'
  | 'unarchive'

export function TaskDialog({
  task,
  kind,
  onKind,
  onFollowedUp,
}: {
  task: Task
  kind: TaskDialogKind
  onKind: (kind: TaskDialogKind | undefined) => void
  onFollowedUp?: (followUp: Task) => void
}) {
  const close = () => onKind(undefined)
  if (kind === 'snooze') return <SnoozeTaskDialog task={task} onClose={close} />
  if (kind === 'archive') return <ArchiveDialog task={task} onClose={close} />
  if (kind === 'unarchive') return <UnarchiveDialog task={task} onClose={close} />
  if (kind === 'edit') return <EditTaskDialog task={task} onClose={close} />
  if (kind === 'reset') return <ResetDialog task={task} onClose={close} />
  if (kind === 'delete') {
    return <DeleteDialog task={task} onClose={close} onArchiveInstead={() => onKind('archive')} />
  }
  return (
    <FollowUpDialog
      task={task}
      onClose={close}
      {...(onFollowedUp && { onCreated: onFollowedUp })}
    />
  )
}

export function TaskActionsMenu({
  task,
  onFollowedUp,
  contextAt,
  contextOnly = false,
  onMenuClose,
  onPickBlocker,
  onOpenBrief,
  history,
  sideChat,
}: {
  task: Task
  contextAt?: MenuPosition | undefined
  contextOnly?: boolean
  onMenuClose?: () => void
  onPickBlocker?: (task: Task, event?: string) => void
  onFollowedUp?: (followUp: Task) => void
  onOpenBrief?: (() => void) | undefined
  history?: TaskHistory | undefined
  sideChat?: TaskSideChat | undefined
}) {
  const enabledAgents = useEnabledAgents()
  const [position, setPosition] = useState<MenuPosition>()
  const open = position !== undefined
  const close = () => {
    setPosition(undefined)
    onMenuClose?.()
  }
  useEffect(() => {
    if (contextAt) setPosition(contextAt)
  }, [contextAt])
  const [dialog, setDialog] = useState<TaskDialogKind>()
  const [error, setError] = useState<string>()
  const allTasks = useTasks()
  const parentName = allTasks.find((t) => t.id === task.parentId)?.displayId ?? 'its parent'
  const pick = (event: string) => {
    close()
    return onPickBlocker
      ? onPickBlocker(task, event)
      : window.dispatchEvent(new CustomEvent(event, { detail: task.id }))
  }
  const errorClass = contextOnly ? menuStyles.error : styles.error
  useEffect(() => {
    if (contextOnly) return
    const close = () => setPosition(undefined)
    const onArchive = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === task.id && !task.archived) {
        close()
        setDialog('archive')
      }
    }
    const onEdit = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === task.id && !task.archived) {
        close()
        setDialog('edit')
      }
    }
    const onDelete = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === task.id) {
        close()
        setDialog('delete')
      }
    }
    const onUnarchive = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === task.id && task.archived) {
        close()
        setDialog('unarchive')
      }
    }
    const onReset = (event: Event) => {
      if (
        event instanceof CustomEvent &&
        event.detail === task.id &&
        resetRefusal(task) === undefined
      ) {
        close()
        setDialog('reset')
      }
    }
    const onFollowUp = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === task.id && task.stage === 'done') {
        close()
        setDialog('follow-up')
      }
    }
    const onSnooze = (event: Event) => {
      if (
        event instanceof CustomEvent &&
        event.detail === task.id &&
        task.stage === 'backlog' &&
        !task.archived
      ) {
        close()
        setDialog('snooze')
      }
    }
    window.addEventListener(snoozeTaskEvent, onSnooze)
    window.addEventListener(archiveTaskEvent, onArchive)
    window.addEventListener(editTaskEvent, onEdit)
    window.addEventListener(deleteTaskEvent, onDelete)
    window.addEventListener(resetTaskEvent, onReset)
    window.addEventListener(unarchiveTaskEvent, onUnarchive)
    window.addEventListener(followUpTaskEvent, onFollowUp)
    return () => {
      window.removeEventListener(snoozeTaskEvent, onSnooze)
      window.removeEventListener(archiveTaskEvent, onArchive)
      window.removeEventListener(editTaskEvent, onEdit)
      window.removeEventListener(deleteTaskEvent, onDelete)
      window.removeEventListener(resetTaskEvent, onReset)
      window.removeEventListener(unarchiveTaskEvent, onUnarchive)
      window.removeEventListener(followUpTaskEvent, onFollowUp)
    }
  }, [task, contextOnly])

  const action = statusAction(task)
  const refusal = resetRefusal(task)
  const linear = task.source?.linear

  const activity = usePendingAction(`task-actions:${task.id}`)
  const act = (work: () => Promise<unknown>) => {
    setError(undefined)
    return activity.run(work)?.then(
      () => close(),
      (failure: unknown) => {
        close()
        setError(readableError(failure))
      },
    )
  }

  const choose = (which: TaskDialogKind) => {
    close()
    setError(undefined)
    setDialog(which)
  }

  const dialogs = dialog && (
    <TaskDialog
      task={task}
      kind={dialog}
      onKind={setDialog}
      {...(onFollowedUp && { onFollowedUp })}
    />
  )

  const deleteItem = (
    <ActionButton
      type="button"
      role="menuitem"
      className={styles.item}
      onClick={() => choose('delete')}
    >
      <span className={styles.label}>Delete…</span>
    </ActionButton>
  )

  const conversationItems = (history || sideChat) && (
    <>
      {history && <HistoryItem history={history} close={close} />}
      {sideChat &&
        (sideChat.available ? (
          <ActionButton
            type="button"
            role="menuitem"
            className={styles.item}
            onClick={() => {
              close()
              sideChat.onOpen()
            }}
          >
            <span className={styles.label}>Side chat</span>
          </ActionButton>
        ) : (
          <ActionButton
            type="button"
            role="menuitem"
            className={styles.item}
            aria-disabled
            title="Side chat asks about a Task Lead conversation. This Task has none yet."
          >
            <span className={styles.label}>Side chat</span>
            <span className={styles.hint}>No Task Lead conversation yet</span>
          </ActionButton>
        ))}
      <hr className={styles.separator} />
    </>
  )

  if (task.archived) {
    return (
      <div className={styles.anchor}>
        {!contextOnly && (
          <ActionButton
            type="button"
            className={styles.more}
            aria-label="Task actions"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={(event) => {
              event.stopPropagation()
              setError(undefined)
              if (open) close()
              else setPosition(buttonPosition(event.currentTarget))
            }}
          >
            <MoreIcon />
          </ActionButton>
        )}
        {position && (
          <ContextMenu
            at={position}
            label={`Task actions · ${task.displayId}`}
            onClose={close}
            pending={activity.pending}
          >
            <ActionButton
              type="button"
              role="menuitem"
              className={styles.item}
              onClick={() =>
                needsUnarchiveDialog(task)
                  ? choose('unarchive')
                  : act(() => ted.unarchiveTask(task.id))
              }
            >
              <span className={styles.label}>Unarchive</span>
            </ActionButton>
            {conversationItems && <hr className={styles.separator} />}
            {conversationItems}
            <ActionButton
              type="button"
              role="menuitem"
              className={styles.item}
              onClick={() => act(() => navigator.clipboard.writeText(task.displayId))}
            >
              Copy Task ID
            </ActionButton>
            {onOpenBrief && (
              <ActionButton
                type="button"
                role="menuitem"
                className={styles.item}
                onClick={() => {
                  close()
                  onOpenBrief()
                }}
              >
                Full brief
              </ActionButton>
            )}
            {deleteItem}
          </ContextMenu>
        )}
        {error !== undefined && (
          <p className={errorClass} role="alert">
            {error}
          </p>
        )}
        {dialogs}
      </div>
    )
  }

  return (
    <div className={styles.anchor}>
      {!contextOnly && (
        <ActionButton
          type="button"
          className={styles.more}
          aria-label="Task actions"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={(event) => {
            event.stopPropagation()
            setError(undefined)
            if (open) close()
            else setPosition(buttonPosition(event.currentTarget))
          }}
        >
          <MoreIcon />
        </ActionButton>
      )}
      {position && (
        <ContextMenu
          at={position}
          label={`Task actions · ${task.displayId}`}
          onClose={close}
          pending={activity.pending}
        >
          {action && (
            <>
              <FirstItem
                action={action}
                onChoose={() =>
                  action.kind === 'follow-up'
                    ? choose('follow-up')
                    : act(() => runStatusAction(action.kind, task))
                }
              />
              {task.preparation === 'ready' && (
                <ActionButton
                  type="button"
                  role="menuitem"
                  className={styles.item}
                  title="Keeps this Task stopped when Autopilot is on. Resume still starts it."
                  onClick={() => act(() => ted.stopTask(task.id))}
                >
                  <span className={styles.label}>Stop Task</span>
                </ActionButton>
              )}
              <hr className={styles.separator} />
            </>
          )}
          {conversationItems}
          {task.stage === 'backlog' && !task.setup && (
            <>
              <ActionButton
                type="button"
                role="menuitem"
                className={styles.item}
                onClick={() => choose('snooze')}
              >
                <span className={styles.label}>
                  {task.snoozedUntil ? 'Change snooze…' : 'Snooze…'}
                </span>
              </ActionButton>
              {task.snoozedUntil && (
                <ActionButton
                  type="button"
                  role="menuitem"
                  className={styles.item}
                  title="Restores normal Backlog behavior. Automatic starts may start it immediately."
                  onClick={() => act(() => ted.setTaskSnooze(task.id, null))}
                >
                  <span className={styles.label}>Cancel snooze</span>
                </ActionButton>
              )}
              <hr className={styles.separator} />
            </>
          )}
          {task.stage === 'merge' && (
            <>
              <ActionButton
                type="button"
                role="menuitem"
                className={styles.item}
                title="For pull requests you merged on GitHub yourself. TED checks that each one merged before it moves the Task to Done."
                onClick={() => act(() => ted.markDone(task.id))}
              >
                <span className={styles.label}>Mark as Done</span>
              </ActionButton>
              <hr className={styles.separator} />
            </>
          )}
          <Submenu label="Priority" hint={priorityLabels[task.priority]}>
            {priorities.map((priority) => (
              <Choice
                key={priority}
                label={priority === 'none' ? 'No priority' : priorityLabels[priority]}
                checked={task.priority === priority}
                onChoose={() => act(() => ted.setPriority(task.id, priority))}
              />
            ))}
          </Submenu>
          {task.stage !== 'done' && (
            <Submenu label="Task Lead" hint={task.lead ? leadSummary(task.lead) : 'Default'}>
              {agentKinds
                .filter((agent) => enabledAgents.includes(agent) || task.lead?.agent === agent)
                .map((agent) => (
                  <Choice
                    key={agent}
                    label={`${agentLabels[agent]}${enabledAgents.includes(agent) ? '' : ' · Off — new Runs wait'}`}
                    disabled={!enabledAgents.includes(agent)}
                    checked={task.lead?.agent === agent}
                    onChoose={() =>
                      act(() =>
                        task.lead?.agent === agent
                          ? Promise.resolve()
                          : ted.setTaskLead(task.id, { agent }),
                      )
                    }
                  />
                ))}
            </Submenu>
          )}
          {task.stage !== 'done' &&
            (clarifyIsOver(task.stage) ? (
              <ActionButton
                type="button"
                role="menuitem"
                className={styles.item}
                aria-disabled
                title="Clarify is over, so changing its depth would do nothing."
              >
                <span className={styles.label}>Clarify depth</span>
                <span className={styles.hint}>Clarify is over</span>
              </ActionButton>
            ) : (
              <Submenu label="Clarify depth" hint={clarifyDepthLabels[task.clarifyDepth]}>
                {clarifyDepths.map((depth) => (
                  <Choice
                    key={depth}
                    label={clarifyDepthLabels[depth]}
                    checked={task.clarifyDepth === depth}
                    onChoose={() => act(() => ted.setClarifyDepth(task.id, { depth: depth }))}
                  />
                ))}
              </Submenu>
            ))}
          {task.stage !== 'done' && (
            <ActionButton
              type="button"
              role="menuitem"
              className={styles.item}
              onClick={() => {
                close()
                return onPickBlocker
                  ? onPickBlocker(task)
                  : window.dispatchEvent(new CustomEvent(pickBlockerEvent, { detail: task.id }))
              }}
            >
              <span className={styles.label}>Blocked by…</span>
              <span className={styles.hint}>{keysFor('blocked-by').join(' or ')}</span>
            </ActionButton>
          )}
          {task.stage !== 'done' && (
            <ActionButton
              type="button"
              role="menuitem"
              className={styles.item}
              onClick={() => {
                close()
                newChildTask(task)
              }}
            >
              Create child…
            </ActionButton>
          )}
          {task.stage !== 'done' && (
            <ActionButton
              type="button"
              role="menuitem"
              className={styles.item}
              onClick={() => pick(pickChildEvent)}
            >
              Add existing Task as child…
            </ActionButton>
          )}
          <ActionButton
            type="button"
            role="menuitem"
            className={styles.item}
            onClick={() => pick(pickParentEvent)}
          >
            {task.parentId === undefined ? 'Set parent…' : 'Change parent…'}
          </ActionButton>
          {task.parentId !== undefined && (
            <ActionButton
              type="button"
              role="menuitem"
              className={styles.item}
              onClick={() => act(() => changeParent(task, null))}
            >
              {`Detach from ${parentName}`}
            </ActionButton>
          )}
          {onOpenBrief && (
            <ActionButton
              type="button"
              role="menuitem"
              className={styles.item}
              onClick={() => {
                close()
                onOpenBrief()
              }}
            >
              Full brief
            </ActionButton>
          )}
          <ActionButton
            type="button"
            role="menuitem"
            className={styles.item}
            onClick={() => choose('edit')}
          >
            <span className={styles.label}>Edit title and description…</span>
            <span className={styles.hint}>{keysFor('edit').join(' or ')}</span>
          </ActionButton>
          <ActionButton
            type="button"
            role="menuitem"
            className={styles.item}
            onClick={() => act(() => navigator.clipboard.writeText(task.displayId))}
          >
            Copy Task ID
          </ActionButton>
          {linear && (
            <>
              <hr className={styles.separator} />
              <ActionButton
                type="button"
                role="menuitem"
                className={styles.item}
                onClick={() => act(() => ted.openTaskSource(task.id))}
              >
                <span className={styles.label}>Open source in Linear</span>
                <span className={styles.hint}>{linear.identifier}</span>
              </ActionButton>
              {task.linearSync === 'ask' && (
                <ActionButton
                  type="button"
                  role="menuitem"
                  className={styles.item}
                  onClick={() => act(() => ted.allowLinearSync(task.id))}
                >
                  <span className={styles.label}>Sync with Linear</span>
                  <span className={styles.hint}>An Automation made this Task</span>
                </ActionButton>
              )}
            </>
          )}
          <hr className={styles.separator} />
          {refusal === undefined && (
            <ActionButton
              type="button"
              role="menuitem"
              className={styles.item}
              onClick={() => choose('reset')}
            >
              <span className={styles.label}>Reset…</span>
            </ActionButton>
          )}
          {refusal === 'merged' && (
            <button
              type="button"
              role="menuitem"
              className={styles.item}
              aria-disabled
              title="A pull request has merged, so this Task can’t be reset."
            >
              <span className={styles.label}>Reset…</span>
              <span className={styles.hint}>A pull request has merged</span>
            </button>
          )}
          <ActionButton
            type="button"
            role="menuitem"
            className={styles.item}
            onClick={() => choose('archive')}
          >
            <span className={styles.label}>Archive…</span>
            <span className={styles.hint}>{keysFor('archive').join(' or ')}</span>
          </ActionButton>
          {deleteItem}
        </ContextMenu>
      )}
      {error !== undefined && (
        <p className={errorClass} role="alert">
          {error}
        </p>
      )}
      {dialogs}
    </div>
  )
}
