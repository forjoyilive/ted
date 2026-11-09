import type { Factory, StageId, Task } from '@ted/protocol'
import { Button } from '../components/Button.tsx'
import { PlusIcon } from '../components/icons.tsx'
import { PriorityIcon } from '../components/PriorityIcon.tsx'
import styles from './views.module.css'

const stageRank: Record<StageId, number> = {
  backlog: 0,
  intake: 1,
  clarify: 2,
  design: 3,
  work: 4,
  validate: 5,
  review: 6,
  merge: 7,
  done: 8,
}

export const stageOrder = (Object.keys(stageRank) as StageId[]).sort(
  (a, b) => stageRank[a] - stageRank[b],
)

export const stageName = (stage: string) => stage.charAt(0).toUpperCase() + stage.slice(1)

export function factoryName(factories: readonly Factory[], factoryId: string): string {
  return factories.find((f) => f.id === factoryId)?.name ?? 'No Factory'
}

interface TaskViewProps {
  title: string
  tasks: readonly Task[]
  factories: readonly Factory[]
  onOpen: (task: Task) => void
  onNewTask: () => void
}

function ViewHeader({ title, onNewTask }: { title: string; onNewTask: () => void }) {
  return (
    <header className={styles.header}>
      <h1 className={styles.title}>{title}</h1>
      <span className={styles.headerSpacer} />
      <Button size="small" variant="quiet" onClick={onNewTask}>
        <PlusIcon />
        New Task
      </Button>
    </header>
  )
}

export function TaskList({ title, tasks, factories, onOpen, onNewTask }: TaskViewProps) {
  return (
    <section className={styles.pane} aria-label={title}>
      <ViewHeader title={title} onNewTask={onNewTask} />
      <div className={styles.body}>
        {tasks.length === 0 ? (
          <p className={styles.empty}>No Tasks yet.</p>
        ) : (
          <>
            <div className={`${styles.taskRow} ${styles.columnHeads}`} aria-hidden>
              <span />
              <span>ID</span>
              <span>Title</span>
              <span>Factory</span>
              <span>Stage</span>
            </div>
            <ul className={styles.rows}>
              {tasks.map((task) => (
                <li key={task.id}>
                  <button type="button" className={styles.taskRow} onClick={() => onOpen(task)}>
                    <PriorityIcon priority={task.priority} />
                    <span className={styles.id}>{task.displayId}</span>
                    <span className={styles.cell}>{task.title}</span>
                    <span className={`${styles.cell} ${styles.meta}`}>
                      {factoryName(factories, task.factoryId)}
                    </span>
                    <span className={`${styles.cell} ${styles.meta}`}>{stageName(task.stage)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  )
}

export function Board({ title, tasks, onOpen, onNewTask }: TaskViewProps) {
  const stages: string[] = [
    ...stageOrder,
    ...new Set(tasks.map((t) => t.stage).filter((s) => !stageOrder.includes(s))),
  ]

  return (
    <section className={styles.pane} aria-label={title}>
      <ViewHeader title={title} onNewTask={onNewTask} />
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
                <button
                  key={task.id}
                  type="button"
                  className={styles.card}
                  onClick={() => onOpen(task)}
                >
                  <span className={styles.cardId}>
                    <PriorityIcon priority={task.priority} />
                    {task.displayId}
                  </span>
                  <span className={styles.cardTitle}>{task.title}</span>
                </button>
              ))}
            </section>
          )
        })}
      </div>
    </section>
  )
}
