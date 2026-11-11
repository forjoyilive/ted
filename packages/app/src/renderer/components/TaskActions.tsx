import type { Task } from '@ted/protocol'
import { agentKinds } from '@ted/protocol/run'
import { clarifyDepths, clarifyIsOver, priorities } from '@ted/protocol/task'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { keysFor } from '../keymap.ts'
import { runStatusAction, type StatusAction, statusAction } from '../task-actions.ts'
import { agentLabels, clarifyDepthLabels, leadSummary, priorityLabels } from '../task-fields.ts'
import { readableError, ted } from '../ted.ts'
import { EditTaskDialog, editTaskEvent } from '../views/EditTaskDialog.tsx'
import {
  ArchiveDialog,
  archiveTaskEvent,
  DeleteDialog,
  deleteTaskEvent,
  FollowUpDialog,
  followUpTaskEvent,
} from './ArchiveDialogs.tsx'
import { Tooltip } from './Help.tsx'
import { ChevronIcon } from './icons.tsx'
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
  return (
    <div className={styles.first}>
      <button
        type="button"
        role="menuitem"
        className={styles.item}
        aria-describedby={id}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
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
      </button>
      {hover ? (
        <Tooltip id={id} className={styles.tooltip}>
          {action.help}
        </Tooltip>
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
    <div className={styles.submenuAnchor}>
      <button type="button" role="menuitem" aria-haspopup="menu" className={styles.item}>
        <span className={styles.label}>{label}</span>
        <span className={styles.hint}>{hint}</span>
        <ChevronIcon open={false} className={styles.chevron} />
      </button>
      <div className={styles.submenu} role="menu" aria-label={label}>
        {children}
      </div>
    </div>
  )
}

function Choice({
  label,
  checked,
  onChoose,
}: {
  label: string
  checked: boolean
  onChoose: () => void
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      className={styles.item}
      onClick={onChoose}
    >
      <span className={styles.tick} aria-hidden>
        {checked ? '✓' : ''}
      </span>
      <span className={styles.label}>{label}</span>
    </button>
  )
}

export type TaskDialogKind = 'archive' | 'delete' | 'edit' | 'follow-up'

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
  if (kind === 'archive') return <ArchiveDialog task={task} onClose={close} />
  if (kind === 'edit') return <EditTaskDialog task={task} onClose={close} />
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
}: {
  task: Task
  onFollowedUp?: (followUp: Task) => void
}) {
  const [open, setOpen] = useState(false)
  const [dialog, setDialog] = useState<TaskDialogKind>()
  const [error, setError] = useState<string>()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [open])

  useEffect(() => {
    const onArchive = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === task.id && !task.archived) {
        setOpen(false)
        setDialog('archive')
      }
    }
    const onEdit = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === task.id && !task.archived) {
        setOpen(false)
        setDialog('edit')
      }
    }
    const onDelete = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === task.id) {
        setOpen(false)
        setDialog('delete')
      }
    }
    const onFollowUp = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === task.id && task.stage === 'done') {
        setOpen(false)
        setDialog('follow-up')
      }
    }
    window.addEventListener(archiveTaskEvent, onArchive)
    window.addEventListener(editTaskEvent, onEdit)
    window.addEventListener(deleteTaskEvent, onDelete)
    window.addEventListener(followUpTaskEvent, onFollowUp)
    return () => {
      window.removeEventListener(archiveTaskEvent, onArchive)
      window.removeEventListener(editTaskEvent, onEdit)
      window.removeEventListener(deleteTaskEvent, onDelete)
      window.removeEventListener(followUpTaskEvent, onFollowUp)
    }
  }, [task.id, task.archived, task.stage])

  const action = statusAction(task)
  const linear = task.source?.linear

  const act = (work: () => Promise<unknown>) => {
    setOpen(false)
    setError(undefined)
    work().catch((failure: unknown) => setError(readableError(failure)))
  }

  const choose = (which: TaskDialogKind) => {
    setOpen(false)
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
    <button type="button" role="menuitem" className={styles.item} onClick={() => choose('delete')}>
      <span className={styles.label}>Delete…</span>
    </button>
  )

  if (task.archived) {
    return (
      <div ref={ref} className={styles.anchor}>
        <button
          type="button"
          className={styles.more}
          aria-label="Task actions"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => {
            setError(undefined)
            setOpen((o) => !o)
          }}
        >
          <MoreIcon />
        </button>
        {open && (
          <div className={styles.menu} role="menu" aria-label="Task actions">
            <button
              type="button"
              role="menuitem"
              className={styles.item}
              onClick={() => act(() => ted.unarchiveTask(task.id))}
            >
              <span className={styles.label}>Unarchive</span>
            </button>
            {deleteItem}
          </div>
        )}
        {error !== undefined && !open && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {dialogs}
      </div>
    )
  }

  return (
    <div ref={ref} className={styles.anchor}>
      <button
        type="button"
        className={styles.more}
        aria-label="Task actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setError(undefined)
          setOpen((o) => !o)
        }}
      >
        <MoreIcon />
      </button>
      {open && (
        <div className={styles.menu} role="menu" aria-label="Task actions">
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
              {agentKinds.map((agent) => (
                <Choice
                  key={agent}
                  label={agentLabels[agent]}
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
              <button
                type="button"
                role="menuitem"
                className={styles.item}
                aria-disabled
                title="Clarify is over, so changing its depth would do nothing."
              >
                <span className={styles.label}>Clarify depth</span>
                <span className={styles.hint}>Clarify is over</span>
              </button>
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
            <button
              type="button"
              role="menuitem"
              className={styles.item}
              onClick={() => {
                setOpen(false)
                window.dispatchEvent(new CustomEvent(pickBlockerEvent, { detail: task.id }))
              }}
            >
              <span className={styles.label}>Blocked by…</span>
              <span className={styles.hint}>{keysFor('blocked-by').join(' or ')}</span>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className={styles.item}
            onClick={() => choose('edit')}
          >
            <span className={styles.label}>Edit title and description…</span>
            <span className={styles.hint}>{keysFor('edit').join(' or ')}</span>
          </button>
          {linear && (
            <>
              <hr className={styles.separator} />
              <button
                type="button"
                role="menuitem"
                className={styles.item}
                onClick={() => act(() => ted.openTaskSource(task.id))}
              >
                <span className={styles.label}>Open source in Linear</span>
                <span className={styles.hint}>{linear.identifier}</span>
              </button>
              {task.linearSync === 'ask' && (
                <button
                  type="button"
                  role="menuitem"
                  className={styles.item}
                  onClick={() => act(() => ted.allowLinearSync(task.id))}
                >
                  <span className={styles.label}>Sync with Linear</span>
                  <span className={styles.hint}>An Automation made this Task</span>
                </button>
              )}
            </>
          )}
          <hr className={styles.separator} />
          <button
            type="button"
            role="menuitem"
            className={styles.item}
            onClick={() => choose('archive')}
          >
            <span className={styles.label}>Archive…</span>
            <span className={styles.hint}>{keysFor('archive').join(' or ')}</span>
          </button>
          {deleteItem}
        </div>
      )}
      {error !== undefined && !open && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {dialogs}
    </div>
  )
}
