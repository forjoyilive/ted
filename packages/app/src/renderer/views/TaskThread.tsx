import type {
  AgentStageId,
  CheckRun,
  ClarifyDepth,
  Comment,
  ConversationTab,
  DescriptionVersion,
  Factory,
  Priority,
  RunState,
  Task,
  TaskEnding,
  ThreadEvent,
} from '@ted/protocol'
import { clarifyDepths, clarifyIsOver, priorities } from '@ted/protocol/task'
import { useEffect, useId, useRef, useState } from 'react'
import { mergedLine } from '../board.ts'
import { CodeSection } from '../CodeSection.tsx'
import { AgentAvatar, PersonAvatar } from '../components/Avatar.tsx'
import { BlockerPicker } from '../components/BlockerPicker.tsx'
import { Button } from '../components/Button.tsx'
import { CheckOutputDialog } from '../components/CheckOutputDialog.tsx'
import { ChecksRow } from '../components/ChecksRow.tsx'
import { CommentBox } from '../components/CommentBox.tsx'
import { CommentFiles } from '../components/CommentFiles.tsx'
import { EventLine, Findings } from '../components/EventLine.tsx'
import { ChevronIcon, CloseIcon } from '../components/icons.tsx'
import {
  AnsweredCard,
  OpenRequestLine,
  RequestCard,
  WaitingRow,
} from '../components/RequestCard.tsx'
import { Diff, RunChat } from '../components/RunChat.tsx'
import { RunsSection } from '../components/RunsSection.tsx'
import { StageTrack } from '../components/StageTrack.tsx'
import { pickBlockerEvent, TaskActionsMenu } from '../components/TaskActions.tsx'
import { RunIcons, TaskStatusChips } from '../components/TaskStatus.tsx'
import {
  useCheckRuns,
  useComments,
  useDescriptions,
  useStageEntries,
  useTaskRuns,
  useThreadEvents,
} from '../data.ts'
import { useNow } from '../requests.ts'
import { inStage } from '../stage-filter.ts'
import { runStatusAction, statusAction } from '../task-actions.ts'
import {
  clarifyDepthLabels,
  clarifyDepthText,
  formatSize,
  leadSummary,
  priorityLabels,
} from '../task-fields.ts'
import { readableError, ted } from '../ted.ts'
import { CheckRunLine } from './CheckEvents.tsx'
import { ReposField, showsRepos } from './ReposField.tsx'
import { TaskLeadField } from './TaskLeadField.tsx'
import { factoryName, stageName } from './TaskViews.tsx'
import styles from './views.module.css'

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

function leadAgent(task: Task, comment: Comment) {
  const { author } = comment
  if (author.kind !== 'run') return undefined
  return task.runs.find((r) => r.id === author.runId)?.agent ?? task.lead?.agent ?? 'claude'
}

function delivery(task: Task, comment: Comment): string | undefined {
  if (comment.author.kind !== 'human' || task.commentBox === 'done') return undefined
  if (comment.delivered === undefined) return 'Goes to the next Task Lead Run'
  return comment.readAt === undefined ? 'Not read yet' : undefined
}

function NoteRow({ task, comment }: { task: Task; comment: Comment }) {
  const agent = leadAgent(task, comment)
  const author =
    comment.author.kind === 'human' ? 'You' : comment.author.kind === 'ted' ? 'TED' : 'Task Lead'
  const state = delivery(task, comment)
  return (
    <li className={styles.comment}>
      {agent !== undefined ? <AgentAvatar agent={agent} /> : <PersonAvatar name={author} />}
      <div>
        <div className={styles.commentHead}>
          <span className={styles.author}>{author}</span>
          <span className={styles.taskMeta}>{time.format(new Date(comment.createdAt))}</span>
          {state !== undefined && <span className={styles.deliveryNote}>{state}</span>}
        </div>
        {comment.body !== '' && <p className={styles.commentBody}>{comment.body}</p>}
        {comment.attachments && <CommentFiles files={comment.attachments} />}
      </div>
    </li>
  )
}

type ThreadItem =
  | { kind: 'comment'; comment: Comment; createdAt: string }
  | { kind: 'event'; event: ThreadEvent; createdAt: string }
  | { kind: 'check-run'; checkRun: CheckRun; createdAt: string }

type OpenOutput = (checkRun: CheckRun, position: number) => void

function EventRow({
  event,
  checkRun,
  onOpenOutput,
  onOpenRun,
}: {
  event: ThreadEvent
  checkRun: CheckRun | undefined
  onOpenOutput: OpenOutput
  onOpenRun: (runId: string) => void
}) {
  const { runId, changes } = event
  const [showChanges, setShowChanges] = useState(false)
  return (
    <EventLine
      tone={event.tone}
      text={event.text}
      at={event.at}
      action={
        runId !== undefined ? (
          <button type="button" className={styles.linkButton} onClick={() => onOpenRun(runId)}>
            View message
          </button>
        ) : (
          changes !== undefined && (
            <button
              type="button"
              className={styles.linkButton}
              aria-expanded={showChanges}
              onClick={() => setShowChanges((shown) => !shown)}
            >
              {showChanges ? 'Hide changes' : 'Show changes'}
            </button>
          )
        )
      }
    >
      {changes !== undefined && showChanges && (
        <div className={styles.changes}>
          <Diff diff={changes} showPath={false} />
        </div>
      )}
      {(checkRun || event.judgments) && (
        <ChecksRow
          checks={checkRun?.checks ?? []}
          {...(event.judgments && { judgments: event.judgments })}
          onOpen={(position) => checkRun && onOpenOutput(checkRun, position)}
        />
      )}
      {event.findings !== undefined && <Findings text={event.findings} />}
    </EventLine>
  )
}

const tabDotStates: Record<RunState, string> = {
  working: 'working',
  waiting: 'waiting',
  idle: 'idle',
  finished: 'finished',
}

function ConversationTabs({
  tabs,
  shown,
  onShow,
  onClose,
}: {
  tabs: readonly ConversationTab[]
  shown: string | undefined
  onShow: (runId: string | undefined) => void
  onClose: (runId: string) => void
}) {
  if (tabs.length === 0) return null
  return (
    <div className={styles.tabs} role="tablist" aria-label="Thread and Conversations">
      <button
        type="button"
        role="tab"
        aria-selected={shown === undefined}
        className={styles.tab}
        onClick={() => onShow(undefined)}
      >
        Thread
      </button>
      {tabs.map((tab) => (
        <span key={tab.runId} className={styles.tabWrap} data-selected={shown === tab.runId}>
          <button
            type="button"
            role="tab"
            aria-selected={shown === tab.runId}
            className={styles.tab}
            onClick={() => onShow(tab.runId)}
          >
            <span
              className={styles.tabDot}
              data-state={tabDotStates[tab.state]}
              role="img"
              aria-label={tab.state}
            />
            {tab.name}
          </button>
          <button
            type="button"
            className={styles.tabClose}
            aria-label={`Close ${tab.name}`}
            onClick={() => onClose(tab.runId)}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  )
}

export function TaskPanes({
  task,
  tasks,
  factories,
  backLink,
  requestId,
  answeredId,
  onBack,
  onOpenTask,
  onFollowedUp,
}: {
  task: Task
  tasks: readonly Task[]
  factories: readonly Factory[]
  backLink: string | undefined
  requestId?: string | undefined
  answeredId?: string | undefined
  onBack: () => void
  onOpenTask: (ref: string) => void
  onFollowedUp: (followUp: Task) => void
}) {
  const [shown, setShown] = useState<{ taskId: string; runId: string | undefined }>()
  useEffect(() => {
    if (answeredId !== undefined) setShown(undefined)
  }, [answeredId])
  const shownRun = shown?.taskId === task.id ? shown.runId : undefined
  const visibleRun = task.tabs.some((t) => t.runId === shownRun) ? shownRun : undefined
  const show = (runId: string | undefined) => setShown({ taskId: task.id, runId })
  const openRun = (runId: string) => {
    show(runId)
    void ted.openRunTab(task.id, runId).catch((error: unknown) => console.error(error))
  }
  const closeRun = (runId: string) => {
    if (visibleRun === runId) show(undefined)
    void ted.closeRunTab(task.id, runId).catch((error: unknown) => console.error(error))
  }
  return (
    <>
      <TaskThread
        task={task}
        backLink={backLink}
        requestId={requestId}
        answeredId={answeredId}
        onBack={onBack}
        onOpenTask={onOpenTask}
        onFollowedUp={onFollowedUp}
        shownRun={visibleRun}
        onShowRun={show}
        onOpenRun={openRun}
        onCloseRun={closeRun}
      />
      <TaskDetails task={task} tasks={tasks} factories={factories} onOpenRun={openRun} />
    </>
  )
}

export function TaskThread({
  task,
  backLink,
  requestId,
  answeredId,
  onBack,
  onOpenTask,
  onFollowedUp,
  shownRun,
  onShowRun,
  onOpenRun,
  onCloseRun,
}: {
  task: Task
  backLink: string | undefined
  requestId?: string | undefined
  answeredId?: string | undefined
  onBack: () => void
  onOpenTask: (ref: string) => void
  onFollowedUp: (followUp: Task) => void
  shownRun: string | undefined
  onShowRun: (runId: string | undefined) => void
  onOpenRun: (runId: string) => void
  onCloseRun: (runId: string) => void
}) {
  const comments = useComments(task.id)
  const events = useThreadEvents(task.id)
  const checkRuns = useCheckRuns(task.id)
  const [output, setOutput] = useState<{ checkRun: CheckRun; position: number }>()
  const openOutput: OpenOutput = (checkRun, position) => setOutput({ checkRun, position })
  const sentBackRuns = new Set(events.flatMap((e) => (e.checkRunId ? [e.checkRunId] : [])))
  const entries = useStageEntries(task.id, task.stage)
  const [filter, setFilter] = useState<{ taskId: string; stage: AgentStageId }>()
  useEffect(() => {
    if (answeredId !== undefined) setFilter(undefined)
  }, [answeredId])
  const [chosen, setChosen] = useState<{ from: string | undefined; id: string }>()
  const stage = filter?.taskId === task.id ? filter.stage : undefined
  const items: ThreadItem[] = [
    ...comments.map((comment) => ({
      kind: 'comment' as const,
      comment,
      createdAt: comment.createdAt,
    })),
    ...events.map((event) => ({ kind: 'event' as const, event, createdAt: event.at })),
    ...checkRuns
      .filter((checkRun) => !sentBackRuns.has(checkRun.id))
      .map((checkRun) => ({ kind: 'check-run' as const, checkRun, createdAt: checkRun.startedAt })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const shown = inStage(items, entries, stage)
  const unread = comments.some((c) => c.author.kind !== 'human' && c.readAt === undefined)
  useEffect(() => {
    if (unread && shownRun === undefined) {
      void ted.markCommentsRead(task.id).catch(() => undefined)
    }
  }, [unread, task.id, shownRun])
  const open = comments.filter((c) => c.kind !== 'note' && c.answer === undefined)
  const pinnedId = chosen?.from === requestId ? chosen?.id : requestId
  const pinned = open.find((c) => c.id === pinnedId) ?? open[0]
  const headerAction = statusAction(task)
  const now = useNow()
  const activity = mergedLine(task, now) ?? task.activity
  const pin = (id: string) => setChosen({ from: requestId, id })

  return (
    <section className={styles.pane} aria-label="Task thread">
      {backLink !== undefined && (
        <button type="button" className={styles.back} onClick={onBack}>
          {backLink}
        </button>
      )}
      {task.archived && <ArchivedBar task={task} />}
      <header className={styles.taskHeader}>
        <div className={styles.headerRow}>
          <span className={styles.taskMeta}>
            {`${task.displayId}  ·  `}
            {task.followUpOf ? (
              <>
                {'Follow-up to '}
                <button
                  type="button"
                  className={styles.metaLink}
                  onClick={() => task.followUpOf && onOpenTask(task.followUpOf.id)}
                >
                  {task.followUpOf.displayId}
                </button>
              </>
            ) : (
              'Created by you'
            )}
          </span>
          <RunIcons runs={task.runs} />
        </div>
        <div className={styles.headerRow}>
          <h1 className={styles.taskTitle}>{task.title}</h1>
          <TaskStatusChips task={task} onOpenTask={onOpenTask} detailed />
          {(headerAction?.kind === 'resume' || headerAction?.kind === 'retry') && (
            <Button
              size="small"
              variant="primary"
              onClick={() =>
                void runStatusAction(headerAction.kind, task).catch((error: unknown) =>
                  console.error(error),
                )
              }
            >
              {headerAction.label}
            </Button>
          )}
          <TaskActionsMenu task={task} onFollowedUp={onFollowedUp} />
        </div>
        <div className={styles.headerRow}>
          <StageTrack
            track={task.track}
            selected={stage}
            onSelect={(chosen) => setFilter(chosen && { taskId: task.id, stage: chosen })}
          />
          <span className={styles.stageName}>{stageName(task.stage)}</span>
          {task.archived ? (
            <span className={styles.activity}>· {archivedFrom(task.archived.ended)}</span>
          ) : (
            activity !== undefined && <span className={styles.activity}>· {activity}</span>
          )}
        </div>
        {task.description !== '' && <p className={styles.description}>{task.description}</p>}
      </header>
      <ConversationTabs tabs={task.tabs} shown={shownRun} onShow={onShowRun} onClose={onCloseRun} />
      {shownRun !== undefined ? (
        <RunChat
          key={shownRun}
          runId={shownRun}
          onStopTask={() =>
            void ted.stopTask(task.id).catch((error: unknown) => console.error(error))
          }
        />
      ) : (
        <>
          {stage !== undefined && (
            <p className={styles.filterNote}>
              Showing {stageName(stage)} only ·{' '}
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => setFilter(undefined)}
              >
                Show all
              </button>
            </p>
          )}
          <ol className={styles.thread}>
            {shown.map((item) => {
              if (item.kind === 'event') {
                const { event } = item
                return (
                  <EventRow
                    key={event.id}
                    event={event}
                    checkRun={checkRuns.find((r) => r.id === event.checkRunId)}
                    onOpenOutput={openOutput}
                    onOpenRun={onOpenRun}
                  />
                )
              }
              if (item.kind === 'check-run') {
                return (
                  <CheckRunLine
                    key={item.checkRun.id}
                    checkRun={item.checkRun}
                    onOpenOutput={openOutput}
                  />
                )
              }
              const { comment } = item
              if (comment.kind === 'note' && comment.author.kind === 'ted') {
                return (
                  <EventLine
                    key={comment.id}
                    tone="quiet"
                    text={comment.body.replace(/\s+/g, ' ')}
                    at={comment.createdAt}
                  />
                )
              }
              if (comment.kind === 'note') {
                return <NoteRow key={comment.id} task={task} comment={comment} />
              }
              if (comment.answer !== undefined) {
                const { answer } = comment
                const newer =
                  answer.kind === 'superseded'
                    ? comments.find((c) => c.id === answer.by)
                    : undefined
                return (
                  <li key={comment.id} className={styles.requestItem}>
                    <AnsweredCard
                      key={comment.id === answeredId ? 'shown' : 'collapsed'}
                      request={comment}
                      task={task}
                      newer={newer}
                      expanded={comment.id === answeredId}
                    />
                  </li>
                )
              }
              return (
                <li key={comment.id} className={styles.requestItem}>
                  <OpenRequestLine
                    request={comment}
                    task={task}
                    pinned={comment.id === pinned?.id}
                    others={open.length - 1}
                    onPin={() => pin(comment.id)}
                  />
                </li>
              )
            })}
          </ol>
          {pinned ? (
            <div className={styles.pinned}>
              {open.length > 1 && <WaitingRow requests={open} pinnedId={pinned.id} onPin={pin} />}
              <RequestCard key={pinned.id} request={pinned} task={task} onOpenRun={onOpenRun} />
            </div>
          ) : (
            <div className={styles.pinned}>
              <CommentBox key={task.id} task={task} onFollowedUp={onFollowedUp} />
            </div>
          )}
        </>
      )}
      {output && (
        <CheckOutputDialog
          checkRun={checkRuns.find((r) => r.id === output.checkRun.id) ?? output.checkRun}
          position={output.position}
          onClose={() => setOutput(undefined)}
        />
      )}
    </section>
  )
}

function archivedFrom(ended: TaskEnding): string {
  if (ended.kind === 'never-started') return 'Archived before it started'
  if (ended.kind === 'merged') return 'Archived from Done'
  if (ended.kind === 'pull-request-closed') {
    return 'Archived after its pull request was closed on GitHub'
  }
  return `Archived from ${stageName(ended.stage)}`
}

function ArchivedBar({ task }: { task: Task }) {
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const at = task.archived?.at
  return (
    <div className={styles.archivedBar}>
      <span>
        {`Archived ${at ? new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''}`}
      </span>
      <span aria-hidden>·</span>
      <button
        type="button"
        className={styles.archivedAction}
        disabled={busy}
        onClick={() => {
          setBusy(true)
          setError(undefined)
          ted
            .unarchiveTask(task.id)
            .catch((failure: unknown) => setError(readableError(failure)))
            .finally(() => setBusy(false))
        }}
      >
        Unarchive
      </button>
      {error !== undefined && (
        <span className={styles.archivedError} role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

export function TaskDetails({
  task,
  tasks,
  factories,
  onOpenRun,
}: {
  task: Task
  tasks: readonly Task[]
  factories: readonly Factory[]
  onOpenRun: (runId: string) => void
}) {
  const [error, setError] = useState<string>()
  const change = (request: Promise<unknown>) => {
    setError(undefined)
    request.catch((failure: unknown) => setError(readableError(failure)))
  }
  const editable = !task.archived
  const blocks = tasks.filter((t) => t.blockedBy.includes(task.id))
  const clarifyOver = clarifyIsOver(task.stage)
  const factory = factories.find((f) => f.id === task.factoryId)
  return (
    <aside className={styles.detailsPane} aria-label="Task details">
      <dl className={styles.details}>
        <dt>Priority</dt>
        <dd>
          {editable ? (
            <FieldSelect
              label="Priority"
              text={priorityLabels[task.priority]}
              value={task.priority}
              options={[...priorities].reverse().map((p) => [p, priorityLabels[p]])}
              onChange={(value) => change(ted.setPriority(task.id, value as Priority))}
            />
          ) : (
            priorityLabels[task.priority]
          )}
        </dd>
        <dt>Task Lead</dt>
        <dd>
          {task.archived ? (
            task.lead ? (
              leadSummary(task.lead)
            ) : (
              'Default'
            )
          ) : (
            <TaskLeadField key={task.id} task={task} />
          )}
        </dd>
        <dt>Clarify depth</dt>
        <dd>
          {editable && !clarifyOver ? (
            <FieldSelect
              label="Clarify depth"
              text={clarifyDepthText(task)}
              value={task.clarifyDepth}
              options={clarifyDepths.map((d) => [d, clarifyDepthLabels[d]])}
              onChange={(value) => change(ted.setClarifyDepth(task.id, value as ClarifyDepth))}
            />
          ) : (
            <>
              {clarifyDepthText(task)}
              {editable && task.stage !== 'done' && (
                <span className={styles.fieldNote}>
                  Clarify is over, so changing the depth would do nothing.
                </span>
              )}
            </>
          )}
        </dd>
        {factory && showsRepos(factory) && (
          <>
            <dt>Repos</dt>
            <dd>
              <ReposField key={task.id} task={task} factory={factory} />
            </dd>
          </>
        )}
        {task.stage !== 'done' && (
          <>
            <dt>Blocked by</dt>
            <dd>
              {task.archived ? (
                task.blockedBy
                  .map((id) => tasks.find((t) => t.id === id)?.displayId ?? 'a deleted Task')
                  .join(', ') || '—'
              ) : (
                <BlockedByField key={task.id} task={task} tasks={tasks} />
              )}
            </dd>
          </>
        )}
        {blocks.length > 0 && (
          <>
            <dt>Blocks</dt>
            <dd>
              <ul className={styles.detailList}>
                {blocks.map((t) => (
                  <li key={t.id}>
                    {t.displayId}
                    <span className={styles.detailMeta}>{t.title}</span>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
        <dt>Factory</dt>
        <dd>{factoryName(factories, task.factoryId)}</dd>
        <dt>Stage</dt>
        <dd>{stageName(task.stage)}</dd>
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
      {error !== undefined && (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      )}
      <CodeSection task={task} />
      <TaskRuns task={task} onOpenRun={onOpenRun} />
      <TaskBriefSection task={task} />
    </aside>
  )
}

function FieldSelect({
  label,
  text,
  value,
  options,
  onChange,
}: {
  label: string
  text: string
  value: string
  options: readonly (readonly [string, string])[]
  onChange: (value: string) => void
}) {
  return (
    <span className={styles.fieldSelect}>
      <span aria-hidden>{text}</span>
      <ChevronIcon open className={styles.fieldChevron} />
      <select
        aria-label={label}
        className={styles.fieldSelectControl}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map(([option, name]) => (
          <option key={option} value={option}>
            {name}
          </option>
        ))}
      </select>
    </span>
  )
}

function TaskBriefSection({ task }: { task: Task }) {
  const [open, setOpen] = useState(false)
  const [history, setHistory] = useState(false)
  const versions = useDescriptions(task.id)
  const original = versions?.[0]
  const edits = (versions?.length ?? 1) - 1
  return (
    <section className={styles.briefSection} aria-label="Task brief">
      <h2 className={styles.sectionHeading}>Task brief</h2>
      <div className={styles.originalRow}>
        <button
          type="button"
          className={styles.originalToggle}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <ChevronIcon open={open} />
          Original request
        </button>
        <button type="button" className={styles.linkButton} onClick={() => setHistory(true)}>
          {edits === 0 ? 'History' : `History · ${edits} ${edits === 1 ? 'edit' : 'edits'}`}
        </button>
      </div>
      {open && (
        <p className={styles.originalText}>
          {original === undefined
            ? 'Loading…'
            : original.text.trim() !== ''
              ? original.text
              : task.source
                ? `Created from ${task.source.linear?.identifier ?? task.source.url} with no description.`
                : 'No description.'}
        </p>
      )}
      {history && versions !== undefined && (
        <DescriptionHistory task={task} versions={versions} onClose={() => setHistory(false)} />
      )}
    </section>
  )
}

const historyTime = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

function DescriptionHistory({
  task,
  versions,
  onClose,
}: {
  task: Task
  versions: readonly DescriptionVersion[]
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const headingId = useId()
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  return (
    <dialog
      ref={dialog}
      className={styles.historyDialog}
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <header className={styles.historyHead}>
        <h2 id={headingId} className={styles.historyHeading}>
          {`${task.displayId} description history`}
        </h2>
        <button type="button" className={styles.historyClose} aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <ol className={styles.historyList}>
        {[...versions].reverse().map((v) => (
          <li key={v.version} className={styles.historyItem}>
            <p className={styles.historyMeta}>
              {v.version === 1
                ? `Original request · ${historyTime.format(new Date(v.at))}`
                : `Version ${v.version} · edited by you ${historyTime.format(new Date(v.at))}`}
              {v.version === versions.length && versions.length > 1 ? ' · current' : ''}
            </p>
            <p className={styles.historyText}>
              {v.text.trim() === '' ? 'No description.' : v.text}
            </p>
          </li>
        ))}
      </ol>
    </dialog>
  )
}

function TaskRuns({ task, onOpenRun }: { task: Task; onOpenRun: (runId: string) => void }) {
  return <RunsSection runs={useTaskRuns(task.id)} onOpenRun={onOpenRun} />
}

function BlockedByField({ task, tasks }: { task: Task; tasks: readonly Task[] }) {
  const [error, setError] = useState<string>()
  const [searchRequest, setSearchRequest] = useState(0)
  useEffect(() => {
    const onPick = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === task.id) setSearchRequest((n) => n + 1)
    }
    window.addEventListener(pickBlockerEvent, onPick)
    return () => window.removeEventListener(pickBlockerEvent, onPick)
  }, [task.id])
  const blockers = task.blockedBy.flatMap((id) => tasks.filter((t) => t.id === id))
  const gone = task.blockedBy.filter((id) => !tasks.some((t) => t.id === id))
  const change = (request: Promise<Task>) => {
    setError(undefined)
    request.catch((failure: unknown) => setError(readableError(failure)))
  }
  return (
    <>
      <BlockerPicker
        tasks={tasks.filter((t) => t.id !== task.id)}
        blockers={blockers}
        menuAlign="end"
        searchRequest={searchRequest}
        onAdd={(id) => change(ted.blockTask(task.id, id))}
        onRemove={(id) => change(ted.unblockTask(task.id, id))}
      />
      {gone.map((id) => (
        <p key={id} className={styles.deletedBlocker}>
          A deleted Task
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => change(ted.unblockTask(task.id, id))}
          >
            Remove
          </button>
        </p>
      ))}
      {error !== undefined && (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      )}
    </>
  )
}
