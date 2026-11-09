import type { AgentStageId, Comment, Factory, Task } from '@ted/protocol'
import { useState } from 'react'
import { CodeSection } from '../CodeSection.tsx'
import { AgentAvatar, PersonAvatar } from '../components/Avatar.tsx'
import { AnsweredCard, OpenRequestLine, RequestCard } from '../components/RequestCard.tsx'
import { StageTrack } from '../components/StageTrack.tsx'
import { RunIcons, TaskStatusChips } from '../components/TaskStatus.tsx'
import { useComments, useStageEntries } from '../data.ts'
import { inStage } from '../stage-filter.ts'
import { clarifyDepthLabels, formatSize, leadSummary, priorityLabels } from '../task-fields.ts'
import { factoryName, stageName } from './TaskViews.tsx'
import styles from './views.module.css'

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

function leadAgent(task: Task, comment: Comment) {
  const { author } = comment
  if (author.kind !== 'run') return undefined
  return task.runs.find((r) => r.id === author.runId)?.agent ?? task.lead?.agent ?? 'claude'
}

function NoteRow({ task, comment }: { task: Task; comment: Comment }) {
  const agent = leadAgent(task, comment)
  const author =
    comment.author.kind === 'human' ? 'You' : comment.author.kind === 'ted' ? 'TED' : 'Task Lead'
  return (
    <li className={styles.comment}>
      {agent !== undefined ? <AgentAvatar agent={agent} /> : <PersonAvatar name={author} />}
      <div>
        <div className={styles.commentHead}>
          <span className={styles.author}>{author}</span>
          <span className={styles.taskMeta}>{time.format(new Date(comment.createdAt))}</span>
        </div>
        <p className={styles.commentBody}>{comment.body}</p>
      </div>
    </li>
  )
}

export function TaskThread({
  task,
  backLink,
  requestId,
  onBack,
  onOpenTask,
}: {
  task: Task
  backLink: string | undefined
  requestId?: string | undefined
  onBack: () => void
  onOpenTask: (ref: string) => void
}) {
  const comments = useComments(task.id)
  const entries = useStageEntries(task.id, task.stage)
  const [filter, setFilter] = useState<{ taskId: string; stage: AgentStageId }>()
  const [chosen, setChosen] = useState<{ from: string | undefined; id: string }>()
  const stage = filter?.taskId === task.id ? filter.stage : undefined
  const shown = inStage(comments, entries, stage)
  const open = comments.filter((c) => c.kind !== 'note' && c.answer === undefined)
  const pinnedId = chosen?.from === requestId ? chosen?.id : requestId
  const pinned = open.find((c) => c.id === pinnedId) ?? open[0]

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
        {shown.map((comment) => {
          if (comment.kind === 'note') {
            return <NoteRow key={comment.id} task={task} comment={comment} />
          }
          if (comment.answer !== undefined) {
            return (
              <li key={comment.id} className={styles.requestItem}>
                <AnsweredCard request={comment} task={task} />
              </li>
            )
          }
          if (comment.id === pinned?.id) return null
          return (
            <li key={comment.id} className={styles.requestItem}>
              <OpenRequestLine
                request={comment}
                onPin={() => setChosen({ from: requestId, id: comment.id })}
              />
            </li>
          )
        })}
      </ol>
      {pinned && (
        <div className={styles.pinned}>
          <RequestCard key={pinned.id} request={pinned} task={task} />
        </div>
      )}
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
        {task.lead && (
          <>
            <dt>Task Lead</dt>
            <dd>{leadSummary(task.lead)}</dd>
          </>
        )}
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
