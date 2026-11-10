import type {
  AgentStageId,
  CheckRun,
  ClarifyDepth,
  Comment,
  ConversationTab,
  DescriptionVersion,
  Factory,
  LineComment,
  Priority,
  RunState,
  Task,
  TaskBrief,
  TaskEnding,
  ThreadEvent,
} from '@ted/protocol'
import { clarifyDepths, clarifyIsOver, priorities } from '@ted/protocol/task'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { mergedLine } from '../board.ts'
import { CodeSection } from '../CodeSection.tsx'
import { type ChangedFile, changedFiles, useTaskChanges } from '../changes.ts'
import { AppLogView } from '../components/AppLogView.tsx'
import { AppsSection, type ShownApp } from '../components/AppsSection.tsx'
import { AgentAvatar, PersonAvatar } from '../components/Avatar.tsx'
import { BlockerPicker } from '../components/BlockerPicker.tsx'
import { Button } from '../components/Button.tsx'
import { ChangesSection } from '../components/ChangesSection.tsx'
import { CheckOutputDialog } from '../components/CheckOutputDialog.tsx'
import { ChecksRow } from '../components/ChecksRow.tsx'
import { CommentBox } from '../components/CommentBox.tsx'
import { CommentFiles } from '../components/CommentFiles.tsx'
import { DetailsSection } from '../components/DetailsSection.tsx'
import { AllChanges, type DiffSeams, DiffView } from '../components/DiffViews.tsx'
import { EventLine, Findings } from '../components/EventLine.tsx'
import { acceptedPositions } from '../components/FailureDetails.tsx'
import { FullBrief } from '../components/FullBrief.tsx'
import { ChevronIcon, CloseIcon } from '../components/icons.tsx'
import {
  DraftBar,
  isDraft,
  SentLineComments,
  UnsentChip,
  useDiffComments,
  useLineComments,
} from '../components/LineComments.tsx'
import {
  AnsweredCard,
  OpenRequestLine,
  RequestCard,
  WaitingRow,
} from '../components/RequestCard.tsx'
import { DetailsPane } from '../components/ResizableSidebar.tsx'
import { Diff, RunChat } from '../components/RunChat.tsx'
import { RunsSection } from '../components/RunsSection.tsx'
import { ScrollMemory } from '../components/ScrollMemory.tsx'
import { StageTrack } from '../components/StageTrack.tsx'
import { TalkThrough } from '../components/TalkThrough.tsx'
import { pickBlockerEvent, TaskActionsMenu } from '../components/TaskActions.tsx'
import { TaskShell } from '../components/TaskShell.tsx'
import { RunIcons, TaskStatusChips } from '../components/TaskStatus.tsx'
import {
  useCheckRuns,
  useComments,
  useDescriptions,
  useFailures,
  useStageEntries,
  useTaskBrief,
  useTaskRuns,
  useThreadEvents,
} from '../data.ts'
import { briefPart, briefSummary } from '../details.ts'
import { openInEditor } from '../editor.ts'
import {
  type ChangesView,
  type MiddlePaneAction,
  type MiddlePaneState,
  middlePane,
  middlePaneStep,
} from '../middle-pane.ts'
import { useProfile } from '../profile.tsx'
import { useNow } from '../requests.ts'
import { openShellEvent, takeShellRequest } from '../shell.ts'
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
import { formatDate, formatTime } from '../time.ts'
import { CheckRunLine } from './CheckEvents.tsx'
import { ReposField, showsRepos } from './ReposField.tsx'
import { TaskGatesField } from './TaskGatesField.tsx'
import { TaskLeadField } from './TaskLeadField.tsx'
import { factoryName, stageName } from './TaskViews.tsx'
import styles from './views.module.css'

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

interface LineLinks {
  current: readonly LineComment[]
  onOpen: (comment: LineComment) => void
}

function NoteRow({
  task,
  comment,
  lines,
}: {
  task: Task
  comment: Comment
  lines?: LineLinks | undefined
}) {
  const profile = useProfile()
  const agent = leadAgent(task, comment)
  const author =
    comment.author.kind === 'human'
      ? profile.name
      : comment.author.kind === 'ted'
        ? 'TED'
        : 'Task Lead'
  const state = delivery(task, comment)
  return (
    <li className={styles.comment}>
      {agent !== undefined ? (
        <AgentAvatar agent={agent} />
      ) : (
        <PersonAvatar
          name={author}
          photo={comment.author.kind === 'human' ? profile.photo : undefined}
        />
      )}
      <div>
        <div className={styles.commentHead}>
          <span className={styles.author}>{author}</span>
          <span className={styles.taskMeta}>{formatTime(comment.createdAt)}</span>
          {comment.tutorial && <span className={styles.tutorialTag}>Tutorial</span>}
          {state !== undefined && <span className={styles.deliveryNote}>{state}</span>}
        </div>
        {comment.body !== '' && <p className={styles.commentBody}>{comment.body}</p>}
        {comment.attachments && <CommentFiles files={comment.attachments} />}
        {comment.lineComments && (
          <SentLineComments
            comments={comment.lineComments}
            taskId={task.id}
            current={lines?.current ?? []}
            onOpen={(c) => lines?.onOpen(c)}
          />
        )}
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
  failures,
  checkRun,
  onOpenOutput,
  onOpenRun,
  onOpenPlan,
}: {
  event: ThreadEvent
  failures: readonly import('@ted/protocol').FailureCase[]
  checkRun: CheckRun | undefined
  onOpenOutput: OpenOutput
  onOpenRun: (runId: string) => void
  onOpenPlan: (planId: string) => void
}) {
  const { runId, changes, planId } = event
  const [showChanges, setShowChanges] = useState(false)
  return (
    <EventLine
      tone={event.tone}
      text={event.text}
      at={event.at}
      action={
        planId !== undefined ? (
          <button type="button" className={styles.linkButton} onClick={() => onOpenPlan(planId)}>
            Open chat
          </button>
        ) : runId !== undefined ? (
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
          accepted={acceptedPositions(failures, checkRun?.id ?? '')}
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
  onOpenPlan,
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
  onOpenPlan: (planId: string) => void
  onFollowedUp: (followUp: Task) => void
}) {
  const [state, setState] = useState<MiddlePaneState>({})
  const go = (action: MiddlePaneAction) => setState((s) => middlePaneStep(s, task.id, action))
  useEffect(() => {
    if (answeredId !== undefined) setState((s) => middlePaneStep(s, '', { kind: 'answered' }))
  }, [answeredId])
  const changes = useTaskChanges(task)
  const brief = useTaskBrief(task.id)
  const pane = middlePane(state, task, changes !== undefined)
  const { changes: view, app: shownApp, brief: fullBrief, run: visibleRun, all } = pane
  const showChanges = (next: ChangesView | undefined) => go({ kind: 'changes', view: next })
  const openApp = (chosen: ShownApp) => go({ kind: 'app', app: chosen })
  const closeApp = () => go({ kind: 'app', app: undefined })
  const openBrief = () => go({ kind: 'brief', open: true })
  const show = (runId: string | undefined) => go({ kind: 'run', runId })
  const openRun = (runId: string) => {
    show(runId)
    void ted.openRunTab(task.id, runId).catch((error: unknown) => console.error(error))
  }
  const closeRun = (runId: string) => {
    if (visibleRun === runId) show(undefined)
    void ted.closeRunTab(task.id, runId).catch((error: unknown) => console.error(error))
  }
  const openShell = (repo: string) => go({ kind: 'shell', repo })
  useEffect(() => {
    const take = () => {
      const request = takeShellRequest(task.id)
      if (!request) return
      const name = request.repo ?? task.repos.find((r) => !r.removed)?.name
      if (name === undefined) return
      setState((s) => middlePaneStep(s, task.id, { kind: 'shell', repo: name }))
    }
    take()
    window.addEventListener(openShellEvent, take)
    return () => window.removeEventListener(openShellEvent, take)
  }, [task.id, task.repos])
  const openFile = (file: ChangedFile) => showChanges({ kind: 'diff', file })
  const lineComments = useLineComments(task.id)
  const drafts = lineComments.filter(isDraft)
  const seams: DiffSeams = {
    ...useDiffComments(
      task.id,
      lineComments.filter((c) => isDraft(c) || !c.outdated),
    ),
    onOpenInEditor: (file, line) =>
      openInEditor({
        taskId: task.id,
        repo: file.repo,
        file: file.path,
        ...(line !== undefined && { line, column: 1 }),
      }),
  }
  const comments = useComments(task.id)
  const requestOpen = comments.some((c) => c.kind !== 'note' && c.answer === undefined)
  const back = () => showChanges(undefined)
  const bar = (
    <DraftBar
      taskId={task.id}
      drafts={drafts}
      mode={task.stage === 'done' ? 'done' : requestOpen ? 'request' : 'none'}
      onBack={back}
    />
  )
  const openLine = (comment: LineComment) => {
    const repo = changes?.repos.find((r) => r.name === comment.repo)
    const file = changedFiles(changes).find(
      (f) => f.repo === comment.repo && f.path === comment.path,
    ) ?? {
      repo: comment.repo,
      path: comment.path,
      baseBranch: repo?.baseBranch ?? '',
      added: 0,
      removed: 0,
      uncommitted: false,
    }
    showChanges({ kind: 'diff', file, focus: { side: comment.side, line: comment.start } })
  }
  const draftsIn = (file: ChangedFile) =>
    drafts.filter((d) => d.repo === file.repo && d.path === file.path).length
  const { covered, shell: shellRepo } = pane
  return (
    <>
      {all && changes !== undefined && (
        <AllChanges
          taskId={task.id}
          changes={changes}
          seams={seams}
          footer={bar}
          onCollapse={back}
        />
      )}
      {fullBrief && (
        <FullBrief task={task} brief={brief} onBack={() => go({ kind: 'brief', open: false })} />
      )}
      {view?.kind === 'diff' && (
        <DiffView
          taskId={task.id}
          changes={changes}
          file={view.file}
          seams={seams}
          focus={view.focus}
          footer={bar}
          onBack={back}
          onOpen={openFile}
        />
      )}
      {shellRepo !== undefined && !covered ? (
        <TaskShell
          key={`${task.id}:${shellRepo}`}
          taskId={task.id}
          repo={shellRepo}
          onBack={() => go({ kind: 'shell', repo: undefined })}
        />
      ) : (
        <TaskThread
          task={task}
          backLink={backLink}
          requestId={requestId}
          answeredId={answeredId}
          onBack={onBack}
          onOpenTask={onOpenTask}
          onOpenPlan={onOpenPlan}
          onFollowedUp={onFollowedUp}
          shownRun={visibleRun}
          onShowRun={show}
          onOpenRun={openRun}
          onCloseRun={closeRun}
          hidden={covered}
          lines={{ current: lineComments, onOpen: openLine }}
          shownApp={shownApp}
          onOpenApp={openApp}
          onCloseApp={closeApp}
        />
      )}
      <TaskDetails
        task={task}
        tasks={tasks}
        factories={factories}
        onOpenRun={openRun}
        onOpenShell={openShell}
        shownApp={shownApp}
        onOpenApp={openApp}
        hidden={all}
        changes={
          <ChangesSection
            changes={changes}
            selected={view?.kind === 'diff' ? view.file : undefined}
            onOpen={openFile}
            onExpandAll={() => showChanges({ kind: 'all' })}
            drafts={draftsIn}
            draftTotal={drafts.length}
          />
        }
        brief={brief}
        briefOpen={fullBrief}
        onOpenBrief={openBrief}
      />
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
  onOpenPlan,
  onFollowedUp,
  shownRun,
  onShowRun,
  onOpenRun,
  onCloseRun,
  hidden = false,
  lines,
  shownApp,
  onOpenApp,
  onCloseApp,
}: {
  task: Task
  backLink: string | undefined
  requestId?: string | undefined
  answeredId?: string | undefined
  onBack: () => void
  onOpenTask: (ref: string) => void
  onOpenPlan: (planId: string) => void
  onFollowedUp: (followUp: Task) => void
  shownRun: string | undefined
  onShowRun: (runId: string | undefined) => void
  onOpenRun: (runId: string) => void
  onCloseRun: (runId: string) => void
  hidden?: boolean
  lines?: LineLinks | undefined
  shownApp?: ShownApp | undefined
  onOpenApp?: ((app: ShownApp) => void) | undefined
  onCloseApp?: (() => void) | undefined
}) {
  const comments = useComments(task.id)
  const events = useThreadEvents(task.id)
  const failures = useFailures(task.id)
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
  const talk = open.find((c) => c.kind === 'round' && c.talk?.runId === shownRun)

  if (talk && shownRun !== undefined && shownApp === undefined) {
    return (
      <section
        className={styles.pane}
        aria-label="Task thread"
        style={hidden ? { display: 'none' } : undefined}
      >
        <TalkThrough request={talk} task={task} onBack={() => onShowRun(undefined)} />
      </section>
    )
  }

  return (
    <section
      className={styles.pane}
      aria-label="Task thread"
      style={hidden ? { display: 'none' } : undefined}
    >
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
            ) : task.setup ? (
              'Created by TED'
            ) : task.splitFrom ? (
              <>
                {'Split from '}
                <button
                  type="button"
                  className={styles.metaLink}
                  onClick={() => task.splitFrom && onOpenTask(task.splitFrom.id)}
                >
                  {task.splitFrom.displayId}
                </button>
              </>
            ) : task.fromPlan?.deleted ? (
              'From a deleted planning chat'
            ) : task.fromPlan ? (
              <>
                {'From planning chat '}
                <button
                  type="button"
                  className={styles.metaLink}
                  onClick={() => task.fromPlan && onOpenPlan(task.fromPlan.id)}
                >
                  {task.fromPlan.title}
                </button>
              </>
            ) : (
              'Created by you'
            )}
          </span>
          {task.setup && <span className={styles.setupTag}>Setup</span>}
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
      {shownApp !== undefined ? (
        <AppLogView
          key={`${shownApp.repo}/${shownApp.name}`}
          task={task}
          shown={shownApp}
          onBack={() => onCloseApp?.()}
        />
      ) : shownRun !== undefined ? (
        <RunChat
          key={shownRun}
          runId={shownRun}
          bar={shownRun !== task.leadRunId}
          endedNote={
            task.canResume
              ? 'This Run has ended and is read-only. Resume the Task to carry on.'
              : undefined
          }
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
          <ScrollMemory
            list
            spot={`thread:${task.id}`}
            count={shown.length}
            active={!hidden}
            className={styles.thread}
          >
            {shown.map((item) => {
              if (item.kind === 'event') {
                const { event } = item
                return (
                  <EventRow
                    failures={failures}
                    key={event.id}
                    event={event}
                    checkRun={checkRuns.find((r) => r.id === event.checkRunId)}
                    onOpenOutput={openOutput}
                    onOpenRun={onOpenRun}
                    onOpenPlan={onOpenPlan}
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
                return <NoteRow key={comment.id} task={task} comment={comment} lines={lines} />
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
                      onOpenRun={onOpenRun}
                    />
                    {comment.lineComments && (
                      <SentLineComments
                        comments={comment.lineComments}
                        taskId={task.id}
                        current={lines?.current ?? []}
                        onOpen={(c) => lines?.onOpen(c)}
                      />
                    )}
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
          </ScrollMemory>
          {pinned ? (
            <div className={styles.pinned}>
              <UnsentChip
                drafts={(lines?.current ?? []).filter(isDraft)}
                onOpen={(c) => lines?.onOpen(c)}
              />
              {open.length > 1 && <WaitingRow requests={open} pinnedId={pinned.id} onPin={pin} />}
              <RequestCard
                key={pinned.id}
                request={pinned}
                task={task}
                onOpenRun={onOpenRun}
                onOpenApp={onOpenApp}
                onOpenPlan={onOpenPlan}
              />
            </div>
          ) : (
            <div className={styles.pinned}>
              <UnsentChip
                drafts={(lines?.current ?? []).filter(isDraft)}
                onOpen={(c) => lines?.onOpen(c)}
              />
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
      <span>{`Archived ${at ? formatDate(at, { day: 'numeric', month: 'short' }) : ''}`}</span>
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
  onOpenShell,
  changes,
  hidden = false,
  shownApp,
  onOpenApp,
  brief,
  briefOpen = false,
  onOpenBrief,
}: {
  task: Task
  tasks: readonly Task[]
  factories: readonly Factory[]
  onOpenRun: (runId: string) => void
  onOpenShell: (repo: string) => void
  changes?: ReactNode
  hidden?: boolean
  shownApp?: ShownApp | undefined
  onOpenApp?: ((app: ShownApp) => void) | undefined
  brief?: TaskBrief | null | undefined
  briefOpen?: boolean
  onOpenBrief?: (() => void) | undefined
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
    <DetailsPane className={styles.detailsPane} aria-label="Task details" hidden={hidden}>
      {task.setup && (
        <p className={styles.setupNote}>
          The Design and Review Gates are always on for a setup Task. Tasks started before it merges
          use TED’s defaults.
        </p>
      )}
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
        <dt>Gates</dt>
        <dd className={styles.gatesValue}>
          <TaskGatesField key={task.id} taskId={task.id} />
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
      <CodeSection task={task} onOpenShell={onOpenShell} />
      {changes}
      <TaskRuns task={task} onOpenRun={onOpenRun} />
      <AppsSection task={task} shown={shownApp} onOpenApp={(app) => onOpenApp?.(app)} />
      <TaskBriefSection
        task={task}
        brief={brief}
        open={briefOpen}
        onOpenBrief={() => onOpenBrief?.()}
      />
    </DetailsPane>
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

function TaskBriefSection({
  task,
  brief,
  open,
  onOpenBrief,
}: {
  task: Task
  brief: TaskBrief | null | undefined
  open: boolean
  onOpenBrief: () => void
}) {
  const now = useNow()
  const goal = brief ? briefPart(brief.text, 'Goal') : undefined
  const next = brief ? briefPart(brief.text, 'Next step') : undefined
  return (
    <DetailsSection
      id="brief"
      title="Task brief"
      collapsedSummary={brief === undefined ? undefined : briefSummary(brief, now)}
    >
      {brief === null && (
        <p className={styles.briefEmpty}>The Task Lead hasn’t written a Task brief yet.</p>
      )}
      {brief && (
        <>
          {goal !== undefined && <p className={styles.briefLine}>{`Goal: ${goal}`}</p>}
          {next !== undefined && <p className={styles.briefLine}>{`Next step: ${next}`}</p>}
          <Button size="small" aria-pressed={open} onClick={onOpenBrief}>
            Full brief
          </Button>
        </>
      )}
      <OriginalRequest task={task} />
    </DetailsSection>
  )
}

function OriginalRequest({ task }: { task: Task }) {
  const [open, setOpen] = useState(false)
  const [history, setHistory] = useState(false)
  const versions = useDescriptions(task.id)
  const original = versions?.[0]
  const edits = (versions?.length ?? 1) - 1
  return (
    <>
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
      {open && task.attachments.length > 0 && <CommentFiles files={task.attachments} />}
      {history && versions !== undefined && (
        <DescriptionHistory task={task} versions={versions} onClose={() => setHistory(false)} />
      )}
    </>
  )
}

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
                ? `Original request · ${formatDate(v.at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
                : `Version ${v.version} · edited by you ${formatDate(v.at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`}
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
