import type { Factory, Task } from '@ted/protocol'
import { PriorityIcon } from '../components/PriorityIcon.tsx'
import styles from './views.module.css'

export const stageOrder = ['backlog', 'work', 'done']

export const stageName = (stage: string) => stage.charAt(0).toUpperCase() + stage.slice(1)

export function factoryName(factories: readonly Factory[], factoryId: string): string {
  return factories.find((f) => f.id === factoryId)?.name ?? 'No Factory'
}

interface TaskViewProps {
  title: string
  tasks: readonly Task[]
  factories: readonly Factory[]
  onOpen: (task: Task) => void
}

export function TaskList({ title, tasks, factories, onOpen }: TaskViewProps) {
  return (
    <section className={styles.pane} aria-label={title}>
      <header className={styles.header}>
        <h1 className={styles.title}>{title}</h1>
      </header>
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
                    <PriorityIcon priority="none" />
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

export function Board({ title, tasks, onOpen }: TaskViewProps) {
  const stages = [
    ...stageOrder,
    ...new Set(tasks.map((t) => t.stage).filter((s) => !stageOrder.includes(s))),
  ]

  return (
    <section className={styles.pane} aria-label={title}>
      <header className={styles.header}>
        <h1 className={styles.title}>{title}</h1>
      </header>
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
                    <PriorityIcon priority="none" />
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
