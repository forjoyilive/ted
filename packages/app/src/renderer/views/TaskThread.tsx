import type { AgentStageId, Factory, Task } from '@ted/protocol'
import { useState } from 'react'
import { CodeSection } from '../CodeSection.tsx'
import { AgentAvatar, PersonAvatar } from '../components/Avatar.tsx'
import { StageTrack } from '../components/StageTrack.tsx'
import { RunIcons, TaskStatusChips } from '../components/TaskStatus.tsx'
import { useComments, useStageEntries } from '../data.ts'
import { inStage } from '../stage-filter.ts'
import { clarifyDepthLabels, formatSize, priorityLabels } from '../task-fields.ts'
import { TaskLeadField } from './TaskLeadField.tsx'
import { factoryName, stageName } from './TaskViews.tsx'
import styles from './views.module.css'

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

export function TaskThread({
  task,
  backLink,
  onBack,
  onOpenTask,
}: {
  task: Task
  backLink: string | undefined
  onBack: () => void
  onOpenTask: (ref: string) => void
}) {
  const comments = useComments(task.id)
  const entries = useStageEntries(task.id, task.stage)
  const [filter, setFilter] = useState<{ taskId: string; stage: AgentStageId }>()
  const stage = filter?.taskId === task.id ? filter.stage : undefined
  const shown = inStage(comments, entries, stage)

  return (
    <section className={styles.pane} aria-label="Task thread">
      {backLink !== undefined && (
        <button type="button" className={styles.back} onClick={onBack}>
          {backLink}
        </button>
      )}
      <header className={styles.taskHeader}>
        <div className={styles.headerRow}>
          <span className={styles.taskMeta}>{`${task.displayId}  ·  Created by you`}</span>
          <RunIcons runs={task.runs} />
        </div>
        <div className={styles.headerRow}>
          <h1 className={styles.taskTitle}>{task.title}</h1>
          <TaskStatusChips task={task} onOpenTask={onOpenTask} />
        </div>
        <div className={styles.headerRow}>
          <StageTrack
            track={task.track}
            selected={stage}
            onSelect={(chosen) => setFilter(chosen && { taskId: task.id, stage: chosen })}
          />
          <span className={styles.stageName}>{stageName(task.stage)}</span>
          {task.activity !== undefined && (
            <span className={styles.activity}>· {task.activity}</span>
          )}
        </div>
        {task.description !== '' && <p className={styles.description}>{task.description}</p>}
      </header>
      {stage !== undefined && (
        <p className={styles.filterNote}>
          Showing {stageName(stage)} only ·{' '}
          <button type="button" className={styles.linkButton} onClick={() => setFilter(undefined)}>
            Show all
          </button>
        </p>
      )}
      <ol className={styles.thread}>
        {shown.map((comment) => (
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
      <CodeSection task={task} />
    </aside>
  )
}
