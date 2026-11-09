import type { Factory, Task } from '@ted/protocol'
import type { ReactNode } from 'react'
import { Button } from '../components/Button.tsx'
import { PlusIcon } from '../components/icons.tsx'
import { PriorityIcon } from '../components/PriorityIcon.tsx'
import { RunIcons, TaskStatusChips } from '../components/TaskStatus.tsx'
import { stageName, stageOrder } from '../list-view.ts'
import styles from './views.module.css'

export { stageName, stageOrder }

export function factoryName(factories: readonly Factory[], factoryId: string): string {
  return factories.find((f) => f.id === factoryId)?.name ?? 'No Factory'
}

interface TaskViewProps {
  title: string
  tasks: readonly Task[]
  factories: readonly Factory[]
  onOpen: (task: Task) => void
  onNewTask: () => void
  banners?: ReactNode
  capLine?: string | undefined
}

function ViewHeader({
  title,
  capLine,
  onNewTask,
}: {
  title: string
  capLine?: string | undefined
  onNewTask: () => void
}) {
  return (
    <header className={styles.header}>
      <h1 className={styles.title}>{title}</h1>
      <span className={styles.headerSpacer} />
      {capLine !== undefined && <span className={styles.capLine}>{capLine}</span>}
      <Button size="small" variant="quiet" onClick={onNewTask}>
        <PlusIcon />
        New Task
      </Button>
    </header>
  )
}

export function Board({
  title,
  tasks,
  onOpen,
  onOpenTask,
  onNewTask,
  banners,
  capLine,
}: TaskViewProps & { onOpenTask: (ref: string) => void }) {
  const stages: string[] = [
    ...stageOrder,
    ...new Set(tasks.map((t) => t.stage).filter((s) => !stageOrder.includes(s))),
  ]

  return (
    <section className={styles.pane} aria-label={title}>
      <ViewHeader title={title} capLine={capLine} onNewTask={onNewTask} />
      {banners}
      <div className={styles.board}>
        {stages.map((stage) => {
          const inStage = tasks.filter((t) => t.stage === stage)
          return (
            <section key={stage} className={styles.column} aria-label={stageName(stage)}>
              <h2 className={styles.columnTitle}>
                {stageName(stage)}
                <span className={styles.columnCount}>{inStage.length}</span>
              </h2>
              {inStage.map((task) => (
                <div key={task.id} className={styles.card}>
                  <span className={styles.cardId}>
                    <PriorityIcon priority={task.priority} />
                    {task.displayId}
                    <span className={styles.cardRuns}>
                      <RunIcons runs={task.runs} stacked />
                    </span>
                  </span>
                  <button type="button" className={styles.cardTitle} onClick={() => onOpen(task)}>
                    {task.title}
                  </button>
                  <TaskStatusChips task={task} onOpenTask={onOpenTask} />
                  {task.activity !== undefined && (
                    <span className={styles.cardActivity}>{task.activity}</span>
                  )}
                </div>
              ))}
            </section>
          )
        })}
      </div>
    </section>
  )
}
