import type {
  AgentStageId,
  ChangesSource,
  CheckRun,
  ClarifyDepth,
  Comment,
  Factory,
  LineComment,
  Priority,
  Task,
  TaskChanges,
  TaskEnding,
  TaskFileRef,
  ThreadEvent,
} from '@ted/protocol'
import { clarifyDepths, clarifyIsOver, priorities } from '@ted/protocol/task'
import { type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { mergedLine } from '../board.ts'
import { CodeSection } from '../CodeSection.tsx'
import {
  type ChangedFile,
  changedFiles,
  usePullRequestChanges,
  useTaskChanges,
} from '../changes.ts'
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
import { contextMenu } from '../components/ContextMenu.tsx'
import { AllChanges, type DiffSeams, DiffView } from '../components/DiffViews.tsx'
import { EventLine, Findings } from '../components/EventLine.tsx'
import { acceptedPositions } from '../components/FailureDetails.tsx'
import { FilesSection } from '../components/FilesSection.tsx'
import { FileView } from '../components/FileView.tsx'
import { FullBrief } from '../components/FullBrief.tsx'
import { ChevronIcon } from '../components/icons.tsx'
import {
  DraftBar,
  isDraft,
  SentLineComments,
  UnsentChip,
  useDiffComments,
  useLineComments,
} from '../components/LineComments.tsx'
import { LoadingError, Skeleton } from '../components/Loading.tsx'
import { Markdown } from '../components/Markdown.tsx'
import { QuickOpen } from '../components/QuickOpen.tsx'
import { AnsweredCard, RequestCard } from '../components/RequestCard.tsx'
import { RequestJumpBar } from '../components/RequestJumpBar.tsx'
import { DetailsPane } from '../components/ResizableSidebar.tsx'
import { Diff } from '../components/RunChat.tsx'
import { RunsSection } from '../components/RunsSection.tsx'
import type { ScrollReveal } from '../components/ScrollMemory.tsx'
import { RunWithSideChat } from '../components/SideChat.tsx'
import { StageTrack } from '../components/StageTrack.tsx'
import { TalkThrough } from '../components/TalkThrough.tsx'
import { pickBlockerEvent, TaskActionsMenu } from '../components/TaskActions.tsx'
import { TaskBrowserView } from '../components/TaskBrowserView.tsx'
import { openTaskActions } from '../components/TaskContextMenu.tsx'
import { TaskConversationTabs } from '../components/TaskConversationTabs.tsx'
import { TaskDescription } from '../components/TaskDescription.tsx'
import { TaskDiscussion } from '../components/TaskDiscussion.tsx'
import { TaskShell } from '../components/TaskShell.tsx'
import { RunIcons, TaskStatusChips } from '../components/TaskStatus.tsx'
import {
  useBrowserOpen,
  useCheckRunList,
  useCommentList,
  useComments,
  useFailures,
  useStageEntries,
  useTaskBriefState,
  useTaskRuns,
  useTaskRunsState,
  useThreadEventList,
} from '../data.ts'
import { openInEditor } from '../editor.ts'
import { quickOpenEvent, takeFileRequest, useTaskFiles } from '../files.ts'
import { InboxRequestsContext } from '../inbox-requests.ts'
import {
  type ChangesView,
  type MiddlePaneAction,
  type MiddlePaneState,
  middlePane,
  middlePaneStep,
} from '../middle-pane.ts'
import { useProfile } from '../profile.tsx'
import { ago, headline, requestLabel, useNow } from '../requests.ts'
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
import { formatDate } from '../time.ts'
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
  now,
}: {
  task: Task
  comment: Comment
  lines?: LineLinks | undefined
  now: number
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
          <span className={styles.taskMeta}>{ago(comment.createdAt, now)}</span>
          {comment.tutorial && <span className={styles.tutorialTag}>Tutorial</span>}
          {state !== undefined && <span className={styles.deliveryNote}>{state}</span>}
        </div>
        {comment.body !== '' && <Markdown className={styles.commentBody} text={comment.body} />}
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

export function TaskPanes({
  task,
  tasks,
  factories,
  backLink,
  revealRequest,
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
  revealRequest?: ScrollReveal | undefined
  answeredId?: string | undefined
  onBack: () => void
  onOpenTask: (ref: string) => void
  onOpenPlan: (planId: string) => void
  onFollowedUp: (followUp: Task) => void
}) {
  const [state, setState] = useState<MiddlePaneState>({})
  useEffect(() => {
    if (revealRequest !== undefined) {
      setState({})
      setQuickTask(undefined)
    }
  }, [revealRequest])
  useBrowserOpen(task.id, (app) => {
    setState((s) => middlePaneStep(s, task.id, { kind: 'app', app }))
  })

  const go = (action: MiddlePaneAction) => setState((s) => middlePaneStep(s, task.id, action))
  useEffect(() => {
    if (answeredId !== undefined) setState((s) => middlePaneStep(s, '', { kind: 'answered' }))
  }, [answeredId])
  const [browsing, setBrowsing] = useState(false)
  const [quickTask, setQuickTask] = useState<string>()
  const browse = useCallback(() => setBrowsing(true), [])
  const fileList = useTaskFiles(task, browsing || quickTask === task.id)
  const showQuick = () => {
    setBrowsing(true)
    setQuickTask(task.id)
  }
  useEffect(() => {
    const take = () => {
      if (takeFileRequest(task.id)) {
        setBrowsing(true)
        setQuickTask(task.id)
      }
    }
    take()
    window.addEventListener(quickOpenEvent, take)
    return () => window.removeEventListener(quickOpenEvent, take)
  }, [task.id])
  const inspectFile = (file: TaskFileRef) => {
    setQuickTask(undefined)
    go({ kind: 'file', file })
  }
  const changes = useTaskChanges(task)
  const selectedSource =
    state.changes?.taskId === task.id ? (state.changes.view.source ?? 'local') : 'local'
  const hasPullRequest = task.repos.some((r) => r.pullRequest !== undefined)
  const source: ChangesSource =
    selectedSource === 'pull-request' && hasPullRequest ? 'pull-request' : 'local'
  const remote = usePullRequestChanges(task, source === 'pull-request')
  const shownChanges = source === 'pull-request' ? remote.changes : changes
  const remoteReader = source === 'pull-request' ? remote : undefined
  const briefResource = useTaskBriefState(task.id)
  const brief = briefResource.value
  const pane = middlePane(state, task, shownChanges !== undefined)
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
  const openFile = (file: ChangedFile) => showChanges({ kind: 'diff', file, source })
  const openLocalFile = (file: ChangedFile) => showChanges({ kind: 'diff', file, source: 'local' })
  const lineComments = useLineComments(task)
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
  const reviewOpen = comments.some(
    (c) => c.kind === 'signoff' && c.stage === 'review' && c.answer === undefined,
  )
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
      {quickTask === task.id && (
        <QuickOpen
          key={task.id}
          files={fileList.files}
          error={fileList.error}
          onClose={() => setQuickTask(undefined)}
          onOpen={inspectFile}
          refresh={fileList.refresh}
        />
      )}
      {pane.file && (
        <FileView
          key={`${task.id}:${pane.file.repo}:${pane.file.path}`}
          taskId={task.id}
          file={pane.file}
          backLabel={
            state.changes?.taskId === task.id || state.brief === task.id ? '← Back' : '← Task Lead'
          }
          onBack={() => go({ kind: 'file', file: undefined })}
        />
      )}
      {all && (
        <AllChanges
          taskId={task.id}
          changes={shownChanges}
          seams={source === 'local' ? seams : {}}
          footer={source === 'local' ? bar : undefined}
          backLabel={reviewOpen ? '← Back to sign-off' : 'Collapse'}
          onCollapse={back}
          remote={remoteReader}
          sidebar
        />
      )}
      {fullBrief && (
        <FullBrief
          task={task}
          brief={brief}
          error={briefResource.error}
          retry={briefResource.retry}
          onBack={() => go({ kind: 'brief', open: false })}
        />
      )}
      {view?.kind === 'diff' && (
        <DiffView
          taskId={task.id}
          changes={shownChanges}
          file={view.file}
          seams={source === 'local' ? seams : {}}
          focus={view.focus}
          footer={source === 'local' ? bar : undefined}
          backLabel={reviewOpen ? '← Back to sign-off' : '← Task Lead'}
          onBack={back}
          onOpen={openFile}
          remote={remoteReader}
        />
      )}
      {shellRepo !== undefined && !covered ? (
        <TaskShell
          key={`${task.id}:${shellRepo}`}
          taskId={task.id}
          repo={shellRepo}
          onBack={() => go({ kind: 'shell', repo: undefined })}
        />
      ) : null}
      <TaskThread
        task={task}
        backLink={backLink}
        revealRequest={revealRequest}
        answeredId={answeredId}
        onBack={onBack}
        onOpenTask={onOpenTask}
        onOpenPlan={onOpenPlan}
        onFollowedUp={onFollowedUp}
        taskChanges={changes}
        onOpenFile={openLocalFile}
        onAllChanges={() => showChanges({ kind: 'all' })}
        shownRun={visibleRun}
        onShowRun={show}
        onOpenRun={openRun}
        onCloseRun={closeRun}
        onOpenBrief={openBrief}
        hidden={covered || shellRepo !== undefined}
        lines={{ current: lineComments, onOpen: openLine }}
        shownApp={shownApp}
        onOpenApp={openApp}
        onCloseApp={closeApp}
      />
      <TaskDetails
        task={task}
        tasks={tasks}
        factories={factories}
        onOpenRun={openRun}
        onOpenShell={openShell}
        shownApp={shownApp}
        onOpenApp={openApp}
        changes={
          <ChangesSection
            changes={shownChanges}
            source={source}
            onSource={(next) => showChanges({ kind: 'all', source: next })}
            hasPullRequest={hasPullRequest}
            refresh={remote.refresh}
            selected={view?.kind === 'diff' ? view.file : undefined}
            onOpen={openFile}
            onExpandAll={() => showChanges({ kind: 'all', source })}
            drafts={source === 'local' ? draftsIn : undefined}
            draftTotal={source === 'local' ? drafts.length : 0}
          />
        }
        files={
          <FilesSection
            task={task}
            files={fileList.files}
            error={fileList.error}
            selected={pane.file}
            onOpen={inspectFile}
            onBrowse={browse}
            onQuickOpen={showQuick}
            refresh={fileList.refresh}
          />
        }
      />
    </>
  )
}

export function TaskThread({
  task,
  taskChanges,
  onOpenFile,
  onAllChanges,
  backLink,
  revealRequest,
  answeredId,
  onBack,
  onOpenTask,
  onOpenPlan,
  onFollowedUp,
  shownRun,
  onShowRun,
  onOpenRun,
  onCloseRun,
  onOpenBrief,
  hidden = false,
  lines,
  shownApp,
  onOpenApp,
  onCloseApp,
}: {
  taskChanges?: TaskChanges | undefined
  onOpenFile?: ((file: ChangedFile) => void) | undefined
  onAllChanges?: (() => void) | undefined
  task: Task
  backLink: string | undefined
  revealRequest?: ScrollReveal | undefined
  answeredId?: string | undefined
  onBack: () => void
  onOpenTask: (ref: string) => void
  onOpenPlan: (planId: string) => void
  onFollowedUp: (followUp: Task) => void
  shownRun: string | undefined
  onShowRun: (runId: string | undefined) => void
  onOpenRun: (runId: string) => void
  onCloseRun: (runId: string) => void
  onOpenBrief?: (() => void) | undefined
  hidden?: boolean
  lines?: LineLinks | undefined
  shownApp?: ShownApp | undefined
  onOpenApp?: ((app: ShownApp) => void) | undefined
  onCloseApp?: (() => void) | undefined
}) {
  const runList = useTaskRunsState(
    task.id,
    task.leadRunId !== undefined || task.runs.length > 0 || task.tabs.length > 0,
  )
  const runs = runList.value ?? []
  const earlier = runs
    .filter((run) => run.role === 'lead' && run.id !== task.leadRunId)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const showingSubAgent =
    shownRun !== undefined &&
    shownRun !== task.leadRunId &&
    !earlier.some((run) => run.id === shownRun)
  const commentList = useCommentList(task.id)
  const eventList = useThreadEventList(task.id)
  const checkList = useCheckRunList(task.id)
  const inbox = useContext(InboxRequestsContext)
  const comments = commentList.items.filter((comment) => !inbox?.resolved.has(comment.id))
  const events = eventList.value ?? []
  const checkRuns = checkList.items
  const failures = useFailures(task.id)
  const historyError = commentList.error ?? eventList.error ?? checkList.error
  const historyLoading =
    !historyError && (!commentList.loaded || eventList.value === undefined || !checkList.loaded)
  const retryHistory = () => {
    commentList.retry()
    eventList.retry()
    checkList.retry()
  }
  const [output, setOutput] = useState<{ checkRun: CheckRun; position: number }>()
  const openOutput: OpenOutput = (checkRun, position) => setOutput({ checkRun, position })
  const sentBackRuns = new Set(events.flatMap((e) => (e.checkRunId ? [e.checkRunId] : [])))
  const entries = useStageEntries(task.id, task.stage)
  const [filter, setFilter] = useState<{ taskId: string; stage: AgentStageId }>()
  const [reveal, setReveal] = useState<ScrollReveal>()
  const [conversationReveal, setConversationReveal] = useState<{
    runId: string
    target: ScrollReveal
  }>()
  const openConversation = (runId: string) => {
    setReveal(undefined)
    setConversationReveal({ runId, target: { id: `conversation:${runId}` } })
    onOpenRun(runId)
  }
  useEffect(() => {
    setFilter(undefined)
    setReveal(revealRequest ?? (answeredId === undefined ? undefined : { id: answeredId }))
  }, [revealRequest, answeredId])
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
  const shownItems = new Set(shown)
  const rendered = items.filter(
    (item) =>
      shownItems.has(item) ||
      (item.kind === 'comment' &&
        item.comment.kind !== 'note' &&
        item.comment.answer === undefined),
  )
  const unread = comments.some((c) => c.author.kind !== 'human' && c.readAt === undefined)
  useEffect(() => {
    if (unread && !showingSubAgent) {
      void ted.markCommentsRead(task.id).catch(() => undefined)
    }
  }, [unread, task.id, showingSubAgent])
  const open = comments.filter((c) => c.kind !== 'note' && c.answer === undefined)
  const headerAction = statusAction(task)
  const now = useNow()
  const activity = mergedLine(task, now) ?? task.activity
  const jumpToRequest = (id: string) => {
    if (shownRun !== undefined) onShowRun(undefined)
    setConversationReveal(undefined)
    setFilter(undefined)
    setReveal({ id })
    inbox?.select(id)
  }
  const talk = open.find((c) => c.kind === 'round' && c.talk?.runId === shownRun)

  const renderItem = (item: ThreadItem) => {
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
        <CheckRunLine key={item.checkRun.id} checkRun={item.checkRun} onOpenOutput={openOutput} />
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
      return <NoteRow key={comment.id} task={task} comment={comment} lines={lines} now={now} />
    }
    if (comment.answer !== undefined) {
      const { answer } = comment
      const newer =
        answer.kind === 'superseded' ? comments.find((c) => c.id === answer.by) : undefined
      return (
        <li
          key={comment.id}
          className={styles.requestItem}
          data-chat-item={comment.id}
          tabIndex={-1}
          data-nav-item
        >
          <AnsweredCard
            key={comment.id === answeredId ? 'shown' : 'collapsed'}
            request={comment}
            task={task}
            newer={newer}
            onOpenTask={onOpenTask}
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
      <li
        key={comment.id}
        className={styles.requestItem}
        data-chat-item={comment.id}
        tabIndex={-1}
        data-nav-item
        hidden={!shownItems.has(item)}
      >
        <RequestCard
          taskChanges={taskChanges}
          onOpenFile={onOpenFile}
          onAllChanges={onAllChanges}
          request={comment}
          onOpenTask={onOpenTask}
          task={task}
          onOpenRun={onOpenRun}
          onOpenApp={onOpenApp}
          onOpenPlan={onOpenPlan}
        />
      </li>
    )
  }

  const talking = talk !== undefined && shownRun !== undefined && shownApp === undefined

  return (
    <>
      {talking && (
        <section
          className={styles.pane}
          aria-label="Task thread"
          style={hidden ? { display: 'none' } : undefined}
        >
          <TalkThrough request={talk} task={task} onBack={() => onShowRun(undefined)} />
        </section>
      )}
      <section
        className={`${styles.pane} ${styles.taskPane}`}
        aria-label="Task thread"
        style={hidden || talking ? { display: 'none' } : undefined}
      >
        {backLink !== undefined && (
          <button type="button" className={styles.back} onClick={onBack}>
            {backLink}
          </button>
        )}
        {task.archived && <ArchivedBar task={task} />}
        <header
          className={styles.taskHeader}
          {...contextMenu((at) => openTaskActions(at, [task.id]))}
        >
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
            <TaskActionsMenu task={task} onFollowedUp={onFollowedUp} onOpenBrief={onOpenBrief} />
          </div>
          <TaskDescription task={task} />
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
        </header>
        <TaskConversationTabs
          task={task}
          runs={runs}
          resource={runList}
          shown={shownRun}
          onShow={onShowRun}
          onOpen={openConversation}
          onClose={onCloseRun}
        />
        {shownApp?.browser ? (
          <TaskBrowserView
            task={task}
            shown={shownApp}
            onBack={() => onCloseApp?.()}
            onLog={() => onOpenApp?.({ repo: shownApp.repo, name: shownApp.name })}
          />
        ) : shownApp !== undefined ? (
          <AppLogView
            key={`${shownApp.repo}/${shownApp.name}`}
            task={task}
            shown={shownApp}
            onBack={() => onCloseApp?.()}
          />
        ) : showingSubAgent && shownRun !== undefined && !talking ? (
          <>
            {open.length > 0 && (
              <div className={styles.filterNote}>
                A Task request needs your answer ·{' '}
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => {
                    onShowRun(undefined)
                    if (open[0]) jumpToRequest(open[0].id)
                  }}
                >
                  View in Task Lead
                </button>
              </div>
            )}
            <RunWithSideChat
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
          </>
        ) : null}
        <div className={styles.threadBody} hidden={showingSubAgent || shownApp !== undefined}>
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
          <RequestJumpBar
            requests={open.map((request) => ({
              id: request.id,
              label: requestLabel(request),
              title: headline(request),
            }))}
            onJump={jumpToRequest}
          />
          <TaskDiscussion
            taskId={task.id}
            leadRunId={task.leadRunId}
            earlier={earlier}
            revealRun={
              conversationReveal?.runId === shownRun
                ? conversationReveal?.target
                : shownRun !== task.leadRunId
                  ? shownRun
                  : undefined
            }
            revealRequest={reveal}
            comments={commentList.items}
            entries={entries}
            stage={stage}
            active={!hidden && !talking && !showingSubAgent && shownApp === undefined}
            loading={historyLoading}
            extra={[
              ...rendered.map((item) => ({
                id:
                  item.kind === 'comment'
                    ? `comment:${item.comment.id}`
                    : item.kind === 'event'
                      ? `event:${item.event.id}`
                      : `check:${item.checkRun.id}`,
                at: item.createdAt,
                hidden: !shownItems.has(item),
                node: <ul className={styles.discussionExtra}>{renderItem(item)}</ul>,
              })),
              ...(historyError
                ? [
                    {
                      id: 'history-error',
                      at: task.createdAt,
                      node: <LoadingError error={historyError} retry={retryHistory} />,
                    },
                  ]
                : []),
              ...(historyLoading
                ? [
                    {
                      id: 'history-loading',
                      at: task.createdAt,
                      node: <Skeleton shape="history" label="Loading Task history…" />,
                    },
                  ]
                : []),
            ]}
            footer={(chat) => (
              <div className={styles.threadComposer}>
                <UnsentChip
                  drafts={(lines?.current ?? []).filter(isDraft)}
                  onOpen={(c) => lines?.onOpen(c)}
                />
                <CommentBox
                  key={task.id}
                  task={task}
                  run={chat?.run}
                  hasLineComments={(lines?.current ?? []).some(isDraft)}
                  onFollowedUp={onFollowedUp}
                />
              </div>
            )}
          />
        </div>
        {output && (
          <CheckOutputDialog
            checkRun={checkRuns.find((r) => r.id === output.checkRun.id) ?? output.checkRun}
            position={output.position}
            onClose={() => setOutput(undefined)}
          />
        )}
      </section>
    </>
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
  files,
  hidden = false,
  shownApp,
  onOpenApp,
}: {
  task: Task
  tasks: readonly Task[]
  factories: readonly Factory[]
  onOpenRun: (runId: string) => void
  onOpenShell: (repo: string) => void
  files?: ReactNode
  changes?: ReactNode
  hidden?: boolean
  shownApp?: ShownApp | undefined
  onOpenApp?: ((app: ShownApp) => void) | undefined
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
      <h2 className={styles.detailsHeading}>Task Details</h2>
      {task.setup && (
        <p className={styles.setupNote}>
          The Design and Review sign-offs are always on for a setup Task. Tasks started before it
          merges use TED’s defaults.
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
              onChange={(value) =>
                change(ted.setClarifyDepth(task.id, { depth: value as ClarifyDepth }))
              }
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
        <dt>Sign-offs</dt>
        <dd className={styles.gatesValue}>
          <TaskGatesField key={task.id} taskId={task.id} factoryId={task.factoryId} />
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
      {files}
      <TaskRuns task={task} onOpenRun={onOpenRun} />
      <AppsSection task={task} shown={shownApp} onOpenApp={(app) => onOpenApp?.(app)} />
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
