import type { Factory, Task } from '@ted/protocol'
import { AgentAvatar, PersonAvatar } from '../components/Avatar.tsx'
import { useComments } from '../data.ts'
import { clarifyDepthLabels, formatSize, priorityLabels } from '../task-fields.ts'
import { TaskLeadField } from './TaskLeadField.tsx'
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
        {task.description !== '' && <p className={styles.description}>{task.description}</p>}
      </header>
      <ol className={styles.thread}>
        {comments.map((comment) => (
          <li key={comment.id} className={styles.comment}>
            {comment.author.kind === 'ted' ? (
              <PersonAvatar name="TED" />
            ) : (
              <AgentAvatar agent={task.lead?.agent ?? 'claude'} />
            )}
            <div>
              <div className={styles.commentHead}>
                <span className={styles.author}>
                  {comment.author.kind === 'ted' ? 'TED' : 'Task Lead'}
                </span>
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

export function TaskDetails({
  task,
  tasks,
  factories,
}: {
  task: Task
  tasks: readonly Task[]
  factories: readonly Factory[]
}) {
  const blockers = task.blockedBy.map((id) => tasks.find((t) => t.id === id)?.displayId ?? id)
  return (
    <aside className={styles.detailsPane} aria-label="Task details">
      <dl className={styles.details}>
        <dt>Factory</dt>
        <dd>{factoryName(factories, task.factoryId)}</dd>
        <dt>Stage</dt>
        <dd>{stageName(task.stage)}</dd>
        <dt>Priority</dt>
        <dd>{priorityLabels[task.priority]}</dd>
        <dt>Task Lead</dt>
        <dd>
          <TaskLeadField key={task.id} task={task} />
        </dd>
        <dt>Clarify depth</dt>
        <dd>{clarifyDepthLabels[task.clarifyDepth]}</dd>
        {blockers.length > 0 && (
          <>
            <dt>Blocked by</dt>
            <dd>{blockers.join(', ')}</dd>
          </>
        )}
        {task.attachments.length > 0 && (
          <>
            <dt>Attachments</dt>
            <dd>
              <ul className={styles.detailList}>
                {task.attachments.map((a) => (
                  <li key={`${a.hash}:${a.name}`}>
                    {a.name}
                    <span className={styles.detailMeta}>{formatSize(a.size)}</span>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
        {task.branch !== undefined && (
          <>
            <dt>Branch</dt>
            <dd>{task.branch}</dd>
          </>
        )}
      </dl>
    </aside>
  )
}
