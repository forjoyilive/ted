import type { Task } from '@ted/protocol'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import {
  childChoices,
  childProgress,
  childTree,
  isMerged,
  newChildTask,
  parentChoices,
  parentOf,
  pickChildEvent,
  pickParentEvent,
  progressText,
  type TreeNode,
  waitingText,
} from '../hierarchy.ts'
import { stageName } from '../list-view.ts'
import { readableError, ted } from '../ted.ts'
import { ActionButton } from './ActionButton.tsx'
import { Button } from './Button.tsx'
import styles from './HierarchySection.module.css'
import { ChevronIcon, PlusIcon } from './icons.tsx'
import { TaskPicker } from './TaskPicker.tsx'

export async function changeParent(task: Task, parentId: string | null): Promise<Task> {
  const { revision } = await ted.taskHierarchy(task.id)
  return ted.setTaskParent(task.id, { parentId, revision })
}

function stateLabel(task: Task): string {
  if (isMerged(task)) return 'Merged'
  if (task.archived) return 'Archived, not merged'
  return stageName(task.stage)
}

function stateClass(task: Task): string {
  if (isMerged(task)) return styles.merged ?? ''
  if (task.archived) return styles.archived ?? ''
  return styles.stage ?? ''
}

function usePickRequest(event: string, taskId: string): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onPick = (e: Event) => {
      if (e instanceof CustomEvent && e.detail === taskId) setOpen(true)
    }
    window.addEventListener(event, onPick)
    return () => window.removeEventListener(event, onPick)
  }, [event, taskId])
  return [open, setOpen]
}

function TaskLink({
  task,
  onOpenTask,
  children,
}: {
  task: Task
  onOpenTask?: ((ref: string) => void) | undefined
  children?: ReactNode
}) {
  if (!onOpenTask) return <>{children ?? task.displayId}</>
  return (
    <ActionButton type="button" className={styles.link} onClick={() => onOpenTask(task.displayId)}>
      {children ?? task.displayId}
    </ActionButton>
  )
}

export function ParentField({
  task,
  tasks,
  onOpenTask,
}: {
  task: Task
  tasks: readonly Task[]
  onOpenTask?: ((ref: string) => void) | undefined
}) {
  const parent = parentOf(task, tasks)
  const [picking, setPicking] = usePickRequest(pickParentEvent, task.id)
  const [error, setError] = useState<string>()
  const close = useCallback(() => {
    setPicking(false)
    setError(undefined)
  }, [setPicking])
  const change = (parentId: string | null) => {
    setError(undefined)
    return changeParent(task, parentId).then(close, (failure: unknown) =>
      setError(readableError(failure)),
    )
  }
  const editable = !task.archived
  return (
    <div className={styles.parentRow}>
      {parent ? (
        <span className={styles.parentChip}>
          <TaskLink task={parent} onOpenTask={onOpenTask}>
            <span className={styles.id}>{parent.displayId}</span>
            <span className={styles.title}>{parent.title}</span>
          </TaskLink>
        </span>
      ) : (
        task.parentId !== undefined && <span className={styles.none}>A Task not shown here</span>
      )}
      {!parent && task.parentId === undefined && <span className={styles.none}>—</span>}
      {editable &&
        (picking ? (
          <TaskPicker
            tasks={parentChoices(task, tasks)}
            label="Find a parent Task"
            note="This Task and the Tasks under it are left out"
            error={error}
            menuAlign="end"
            onChoose={(choice) => change(choice.id)}
            onClose={close}
          />
        ) : (
          <>
            <Button size="small" onClick={() => setPicking(true)}>
              {task.parentId === undefined ? 'Set parent' : 'Change'}
            </Button>
            {task.parentId !== undefined && (
              <Button size="small" onClick={() => change(null)}>
                Detach
              </Button>
            )}
          </>
        ))}
      {!picking && error !== undefined && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

function TreeRows({
  nodes,
  tasks,
  collapsed,
  onToggle,
  onOpenTask,
}: {
  nodes: readonly TreeNode[]
  tasks: readonly Task[]
  collapsed: ReadonlySet<string>
  onToggle: (id: string) => void
  onOpenTask?: ((ref: string) => void) | undefined
}) {
  return (
    <ul className={styles.tree}>
      {nodes.map(({ task, children }) => {
        const open = !collapsed.has(task.id)
        return (
          <li key={task.id}>
            <div className={styles.row}>
              {children.length > 0 ? (
                <button
                  type="button"
                  className={styles.caret}
                  aria-expanded={open}
                  aria-label={`${open ? 'Collapse' : 'Expand'} ${task.displayId}`}
                  onClick={() => onToggle(task.id)}
                >
                  <ChevronIcon open={open} />
                </button>
              ) : (
                <span className={styles.caretSpace} />
              )}
              <ActionButton
                type="button"
                data-nav-item
                data-task={task.displayId}
                className={styles.rowLink}
                disabled={!onOpenTask}
                onClick={() => onOpenTask?.(task.displayId)}
              >
                <span className={styles.id}>{task.displayId}</span>
                <span className={styles.title}>{task.title}</span>
                {children.length > 0 && (
                  <span className={styles.count}>{progressText(childProgress(task, tasks))}</span>
                )}
              </ActionButton>
              <span className={`${styles.state} ${stateClass(task)}`}>{stateLabel(task)}</span>
            </div>
            {open && children.length > 0 && (
              <TreeRows
                nodes={children}
                tasks={tasks}
                collapsed={collapsed}
                onToggle={onToggle}
                onOpenTask={onOpenTask}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function ChildrenSection({
  task,
  tasks,
  onOpenTask,
}: {
  task: Task
  tasks: readonly Task[]
  onOpenTask?: ((ref: string) => void) | undefined
}) {
  const tree = childTree(task, tasks)
  const progress = childProgress(task, tasks)
  const waiting = waitingText(task, progress, (t) => stageName(t.stage))
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [picking, setPicking] = usePickRequest(pickChildEvent, task.id)
  const [error, setError] = useState<string>()
  const close = useCallback(() => {
    setPicking(false)
    setError(undefined)
  }, [setPicking])
  const editable = !task.archived && task.stage !== 'done'
  const hasChildren = progress.total > 0 || progress.archived.length > 0
  if (!hasChildren && !editable) return null
  const toggle = (id: string) =>
    setCollapsed((now) => {
      const next = new Set(now)
      if (!next.delete(id)) next.add(id)
      return next
    })
  return (
    <section className={styles.section} aria-label="Children">
      <h3 className={styles.heading}>Children</h3>
      {progress.total > 0 && (
        <div className={styles.progress}>
          <span className={styles.bar} aria-hidden>
            <span
              className={styles.barMerged}
              style={{ width: `${(progress.merged / progress.total) * 100}%` }}
            />
          </span>
          {progressText(progress)}
        </div>
      )}
      {waiting && (
        <p className={styles.waiting} role="status">
          {waiting.lead}{' '}
          {waiting.tasks.map(({ task: child, stage }, i) => (
            <span key={child.id}>
              {i > 0 && ', '}
              <TaskLink task={child} onOpenTask={onOpenTask} /> ({stage})
            </span>
          ))}
          . {waiting.tail}
        </p>
      )}
      {tree.length > 0 && (
        <TreeRows
          nodes={tree}
          tasks={tasks}
          collapsed={collapsed}
          onToggle={toggle}
          onOpenTask={onOpenTask}
        />
      )}
      {progress.archived.length > 0 && (
        <>
          <p className={styles.archivedHeading}>
            Archived without merging · doesn’t hold {task.displayId}
          </p>
          <TreeRows
            nodes={progress.archived.map((t) => ({ task: t, children: [] }))}
            tasks={tasks}
            collapsed={collapsed}
            onToggle={toggle}
            onOpenTask={onOpenTask}
          />
        </>
      )}
      {!hasChildren && (
        <p className={styles.none}>
          No children. Split work into child Tasks when one pull request would be too big.
        </p>
      )}
      {editable && (
        <div className={styles.actions}>
          <Button onClick={() => newChildTask(task)}>
            <PlusIcon />
            Create child
          </Button>
          {picking ? (
            <TaskPicker
              tasks={childChoices(task, tasks)}
              label="Find a Task to add"
              note="Open Tasks in this Factory"
              error={error}
              onChoose={(child) => {
                setError(undefined)
                return changeParent(child, task.id).then(close, (failure: unknown) =>
                  setError(readableError(failure)),
                )
              }}
              onClose={close}
            />
          ) : (
            <Button onClick={() => setPicking(true)}>
              <PlusIcon />
              Add existing Task
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
