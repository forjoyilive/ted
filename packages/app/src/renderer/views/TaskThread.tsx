import type { Factory, Task } from '@ted/protocol'
import { CodeSection } from '../CodeSection.tsx'
import { AgentAvatar } from '../components/Avatar.tsx'
import { useComments } from '../data.ts'
import { factoryName, stageName } from './TaskViews.tsx'
import styles from './views.module.css'

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

export function TaskThread({
  task,
  backLink,
  onBack,
}: {
  task: Task
  backLink: string | undefined
  onBack: () => void
}) {
  const comments = useComments(task.id)

  return (
    <section className={styles.pane} aria-label="Task thread">
      {backLink !== undefined && (
        <button type="button" className={styles.back} onClick={onBack}>
          {backLink}
        </button>
      )}
      <header className={styles.taskHeader}>
        <span className={styles.taskMeta}>{task.displayId}</span>
        <h1 className={styles.taskTitle}>{task.title}</h1>
      </header>
      <ol className={styles.thread}>
        {comments.map((comment) => (
          <li key={comment.id} className={styles.comment}>
            <AgentAvatar agent="claude" />
            <div>
              <div className={styles.commentHead}>
                <span className={styles.author}>Task Lead</span>
                <span className={styles.taskMeta}>{time.format(new Date(comment.createdAt))}</span>
              </div>
              <p className={styles.commentBody}>{comment.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

export function TaskDetails({ task, factories }: { task: Task; factories: readonly Factory[] }) {
  return (
    <aside className={styles.detailsPane} aria-label="Task details">
      <dl className={styles.details}>
        <dt>Factory</dt>
        <dd>{factoryName(factories, task.factoryId)}</dd>
        <dt>Stage</dt>
        <dd>{stageName(task.stage)}</dd>
        {task.branch !== undefined && (
          <>
            <dt>Branch</dt>
            <dd>{task.branch}</dd>
          </>
        )}
      </dl>
      <CodeSection task={task} />
    </aside>
  )
}
