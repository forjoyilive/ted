import type {
  AnswerRequest,
  Comment,
  CommentAnswer,
  MergeRow,
  MessageBox,
  SignOffChanges,
  Task,
  TaskChanges,
  ValidationProgress,
} from '@ted/protocol'
import { failureChoices, namedRepairChoice, validateFailureChoices } from '@ted/protocol/failures'
import {
  answerKind,
  archiveChoice,
  isTrackerGroupAsk,
  keepArchiveChoice,
  noChoicesPicked,
  trackerName,
} from '@ted/protocol/task'
import { openPullRequests } from '@ted/protocol/task-actions'
import { keepMoveChoice, moveChoice, movePlanKey } from '@ted/protocol/task-move'
import { type ComponentProps, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import type { ChangedFile } from '../changes.ts'
import { sendOnEnter, signOffEnter } from '../composer-keys.ts'
import {
  useCheckRuns,
  useComments,
  useEmulators,
  useFactories,
  useFailures,
  useSimulators,
  useTasks,
  useThreadEvents,
  useValidationObligations,
} from '../data.ts'
import { draftField, useMessageDraft } from '../message-drafts.ts'
import { throwsAwayWork } from '../move-plan.ts'
import {
  ago,
  briefSections,
  headline,
  kindLabels,
  poster,
  requestLabel,
  summary,
  useNow,
} from '../requests.ts'
import type { Stages } from '../stage-names.ts'
import { useStages } from '../stages.tsx'
import { readableError, ted } from '../ted.ts'
import { formatDate } from '../time.ts'
import { ActionButton } from './ActionButton.tsx'
import type { ShownApp } from './AppsSection.tsx'
import dialogStyles from './ArchiveDialogs.module.css'
import {
  ArchiveDialog,
  Dialog,
  MovePlanDetails,
  useBlocked,
  useMovePlan,
} from './ArchiveDialogs.tsx'
import { Button } from './Button.tsx'
import { ChangeList } from './ChangesSection.tsx'
import { CheckOutputDialog } from './CheckOutputDialog.tsx'
import { ChecksRow } from './ChecksRow.tsx'
import { DesignReviewContent, removedAgentsDraft } from './DesignReview.tsx'
import { FactoryName as NamedFactory } from './FactoryIcon.tsx'
import { FactoryPicker } from './FactoryPicker.tsx'
import {
  FailureRequestDetails,
  RecordedValidationSummary,
  useRecommendedChoice,
  ValidationSummary,
} from './FailureDetails.tsx'
import { FailureRepairForm } from './FailureRepairForm.tsx'
import { Help } from './Help.tsx'
import { Markdown } from './Markdown.tsx'
import { PreviewRow } from './PreviewRow.tsx'
import { ProposalAnswer, ProposalRows } from './ProposalCard.tsx'
import { isSeveral, QuestionChoices, type QuestionSelection } from './QuestionChoices.tsx'
import { ReferenceText } from './References.tsx'
import styles from './RequestCard.module.css'
import { RequestSnoozeLine } from './RequestSnooze.tsx'
import { RoundAnswers, RoundQuestions, roundTally } from './RoundCard.tsx'
import { AccessChanges, AccessUnknown } from './SandboxAccess.tsx'
import { firstChoice, SimulatorChoices } from './SimulatorChoices.tsx'
import grow from './TextGrow.module.css'

function CardHead({ request, task, now }: { request: Comment; task: Task; now: number }) {
  const again = request.gate?.changes !== undefined && request.stage !== 'merge'
  return (
    <div className={styles.head}>
      <span className={request.failed ? `${styles.kind} ${styles.failedKind}` : styles.kind}>
        {requestLabel(request)}
      </span>
      <span>
        {`${request.round ? ` · Round ${request.round.number}` : ''}${request.proposal ? ` · ${request.proposal.rows.length} Tasks` : ''}${again ? ' · Approval needed again' : ''}${request.gate?.pullRequests ? ' · Merge' : ''} · from ${poster(request, task)} · ${ago(request.createdAt, now)}`}
      </span>
    </div>
  )
}

const methodNames = { squash: 'Squash', merge: 'Merge commit', rebase: 'Rebase' } as const

function checksSummary({ passed, failed, pending }: MergeRow['checks']): string {
  const total = passed + failed + pending
  if (total === 0) return 'No checks'
  if (failed > 0) return `${failed} of ${total} checks failed`
  if (pending > 0) return `${passed} of ${total} checks done`
  return `${total} ${total === 1 ? 'check' : 'checks'} passed`
}

const noCiText = (name: string) => `No CI on ${name}, so Ted merges without waiting`

function NoCiLines({ names }: { names: readonly string[] }) {
  return names.map((name) => (
    <p key={name} className={styles.summary}>
      {noCiText(name)}
    </p>
  ))
}

function MergeRows({
  rows,
  taskId,
  noCi,
}: {
  rows: readonly MergeRow[]
  taskId: string
  noCi: readonly string[]
}) {
  const several = rows.length > 1
  const anyCi = rows.some((row) => !noCi.includes(row.name))
  const which = rows.length === 2 ? 'both' : 'all'
  const lead = several
    ? anyCi
      ? `CI passed and ${which} are mergeable. They merge in this order.`
      : `${which === 'both' ? 'Both' : 'All'} are mergeable. They merge in this order.`
    : anyCi
      ? 'CI passed and it’s mergeable.'
      : 'It’s mergeable.'
  return (
    <>
      <p className={styles.summary}>{lead}</p>
      <ol className={styles.mergeRows} aria-label="Pull requests">
        {rows.map((row, i) => (
          <li key={row.name} className={styles.mergeRow}>
            <span className={styles.mergeIndex}>{i + 1}</span>
            <div className={styles.mergeBody}>
              <div className={styles.mergeLine}>
                <span className={styles.mergeRepo}>{row.name}</span>
                <ActionButton
                  type="button"
                  className={styles.mergeLink}
                  onClick={() => ted.openPullRequest(taskId, row.name)}
                >
                  {`PR #${row.number} · ${row.title}`}
                </ActionButton>
              </div>
              <div className={styles.mergeDetail}>
                {[
                  noCi.includes(row.name)
                    ? noCiText(row.name)
                    : `${row.checks.failed === 0 && row.checks.pending === 0 ? '✓ ' : ''}${checksSummary(row.checks)}`,
                  row.mergeable ? 'Mergeable' : 'Not mergeable yet',
                  methodNames[row.method],
                  ...(row.reviewMissing ? ['1 GitHub review still required'] : []),
                ].join(' · ')}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </>
  )
}

function changedRepos(changes: SignOffChanges) {
  return changes.repos.filter((r) => r.files.length > 0 || r.unavailable)
}

function MergeChangesLine({ changes }: { changes: SignOffChanges }) {
  const changed = changedRepos(changes)
  if (changed.length === 0)
    return <p className={styles.summary}>Changes since you approved: none.</p>
  return <ChangesBlock changes={changes} />
}

function ChangesBlock({
  changes,
  current,
}: {
  changes: SignOffChanges
  current?: TaskChanges | undefined
}) {
  const [all, setAll] = useState(false)
  const files = changes.repos.reduce((sum, repo) => sum + Math.max(1, repo.files.length), 0)
  return (
    <section className={styles.changes} aria-label="Since your last approval">
      <h3 className={styles.sectionHeading}>Since your last approval</h3>
      {changes.summary !== undefined && (
        <Markdown className={styles.sectionBody} text={changes.summary} />
      )}
      <ul className={styles.changedFiles}>
        {changes.repos
          .flatMap((repo) =>
            repo.files.length === 0
              ? [
                  <li key={repo.name} className={styles.changedFile}>
                    <span className={styles.changedRepo}>{repo.name}</span>
                    <span className={styles.noChanges}>
                      {repo.unavailable ? 'Ted couldn’t compare this repo' : 'no changes'}
                    </span>
                  </li>,
                ]
              : repo.files.map((file) => (
                  <li key={`${repo.name}:${file.path}`} className={styles.changedFile}>
                    <span className={styles.changedRepo}>{repo.name}</span>
                    <span className={styles.changedPath} title={file.path}>
                      {file.path}
                    </span>
                    {current?.repos.some((r) => r.name === repo.name && !r.unavailable) &&
                      !current.repos.some(
                        (r) => r.name === repo.name && r.files.some((f) => f.path === file.path),
                      ) && <span className={styles.noChanges}>Not in the current Task diff</span>}
                    <span className={styles.counts}>
                      <span className={styles.added}>{`+${file.added}`}</span>{' '}
                      <span className={styles.removed}>{`−${file.removed}`}</span>
                    </span>
                  </li>
                )),
          )
          .slice(0, all ? undefined : 10)}
      </ul>
      {files > 10 && (
        <button
          type="button"
          className={styles.moreFiles}
          onClick={() => setAll((shown) => !shown)}
        >
          {all ? 'Show fewer' : `Show ${files - 10} more`}
        </button>
      )}
    </section>
  )
}

function PreviouslyApprovedSignOff({ id, task }: { id: string; task: Task }) {
  const previous = useComments(task.id).find((c) => c.id === id)
  if (!previous) return <p className={styles.summary}>Loading previously approved sign-off…</p>
  return (
    <>
      {previous.answer?.kind === 'approved' && (
        <p className={styles.summary}>
          Approved{' '}
          {formatDate(previous.answer.at, {
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </p>
      )}
      <RequestCard request={previous} task={task} readOnly />
    </>
  )
}

function ReviewChanges({
  changes,
  since,
  onOpen,
  onAll,
}: {
  changes: TaskChanges | undefined
  since: SignOffChanges | undefined
  onOpen: (file: ChangedFile) => void
  onAll: () => void
}) {
  return (
    <section className={styles.changes} aria-label="Current Task changes">
      <h3 className={styles.sectionHeading}>Current Task changes</h3>
      <p className={styles.sectionBody}>
        Full current diff against each repo’s base branch. Opening changes does not approve this
        review.
      </p>
      {changes === undefined ? (
        <p className={styles.summary}>Loading changes…</p>
      ) : changes.repos.length === 0 ? (
        <p className={styles.summary}>No worktree is available for this Task.</p>
      ) : (
        <>
          <p className={styles.summary}>
            {changes.files} {changes.files === 1 ? 'file' : 'files'} · +
            {changes.repos.reduce((sum, r) => sum + r.added, 0)} −
            {changes.repos.reduce((sum, r) => sum + r.removed, 0)}
          </p>
          {changes.files > 0 && <Button onClick={onAll}>View all changes</Button>}
          {changes.files === 0 && changes.repos.every((r) => !r.unavailable) && (
            <p className={styles.summary}>No current Task changes.</p>
          )}
          <div>
            <ChangeList changes={changes} onOpen={onOpen} since={since} limit={10} />
          </div>
        </>
      )}
    </section>
  )
}

function BriefSections({ text, title }: { text: string; title: string }) {
  const sections = briefSections(text)
    .map((section) =>
      section.heading.toLowerCase() === 'goal' && section.body.startsWith(title)
        ? { ...section, body: section.body.slice(title.length).trim() }
        : section,
    )
    .filter((section) => section.body !== '')
  return (
    <div className={styles.details}>
      {sections.map(({ heading, body }) => (
        <section key={heading} className={styles.section} aria-label={heading}>
          <h3 className={styles.sectionHeading}>{heading}</h3>
          <Markdown text={body} />
        </section>
      ))}
    </div>
  )
}

function CurrentConfirmationRow({ request, task }: { request: Comment; task: Task }) {
  const obligations = useValidationObligations(task.id)
  return (
    <ConfirmationRow
      request={request}
      task={task}
      readOnly={false}
      currentProgress={obligations?.progress}
    />
  )
}

function ConfirmationRow({
  request,
  task,
  readOnly,
  currentProgress,
}: {
  request: Comment
  task: Task
  readOnly: boolean
  currentProgress?: ValidationProgress | undefined
}) {
  const events = useThreadEvents(task.id)
  const checkRuns = useCheckRuns(task.id)
  const [open, setOpen] = useState<number>()
  const validated = events.findLast((e) => e.validate === 'passed' && e.at <= request.createdAt)
  const checkRun = checkRuns.find((r) => r.id === validated?.checkRunId)
  const snapshot = readOnly ? validated?.validation : undefined
  const progress = readOnly ? snapshot?.progress : currentProgress
  return (
    <>
      {(checkRun || validated?.judgments) && (
        <div className={styles.confirmation}>
          <ChecksRow
            checks={progress ? [] : (checkRun?.checks ?? [])}
            {...(validated?.judgments && { judgments: validated.judgments })}
            onOpen={setOpen}
          />
          {checkRun && open !== undefined && (
            <CheckOutputDialog
              checkRun={checkRun}
              position={open}
              onClose={() => setOpen(undefined)}
              {...(readOnly && { failures: snapshot?.failures ?? [] })}
            />
          )}
        </div>
      )}
      {readOnly ? (
        snapshot && <RecordedValidationSummary taskId={task.id} snapshot={snapshot} />
      ) : (
        <ValidationSummary taskId={task.id} />
      )}
    </>
  )
}

function SignoffDecisions({ text }: { text: string }) {
  const sections = briefSections(text)
  const body = (name: string) =>
    sections.find((s) => s.heading.toLowerCase() === name)?.body.trim() ?? ''
  const decisions = body('decisions so far')
  const open = body('open questions')
  return (
    <>
      <section className={styles.section} aria-label="Decisions so far">
        <h3 className={styles.sectionHeading}>Decisions so far</h3>
        <Markdown text={decisions === '' ? 'None yet.' : decisions} />
      </section>
      <Markdown text={`Open questions: ${open === '' ? 'none.' : open}`} />
    </>
  )
}

function PermissionCommand({ request }: { request: Comment }) {
  const { permission } = request
  if (!permission) return null
  return (
    <>
      <pre className={styles.command}>
        {permission.repo !== undefined && (
          <span className={styles.commandRepo}>{`${permission.repo} $ `}</span>
        )}
        {permission.command}
      </pre>
      {permission.details !== undefined && (
        <pre className={styles.commandDetails}>{permission.details}</pre>
      )}
    </>
  )
}

function SimulatorRequest({
  request,
  readOnly,
  chosen,
  onChoose,
}: {
  request: Comment
  readOnly: boolean
  chosen: string | undefined
  onChoose: (udid: string) => void
}) {
  const now = useNow()
  const live = useAskSlots(request)
  const ask = request.simulator
  if (!ask) return null
  const booted = !readOnly && live?.supported === true ? live.booted : ask.booted
  return (
    <SimulatorChoices
      booted={booted}
      chosen={chosen}
      onChoose={onChoose}
      now={now}
      label="Simulator or emulator to shut down"
      showApp
      disabled={readOnly}
    />
  )
}

function useAskSlots(request: Comment) {
  const simulators = useSimulators()
  const emulators = useEmulators()
  return request.simulator?.platform === 'android' ? emulators : simulators
}

function reasonChoicesOf(request: Comment): string[] {
  return request.author.kind === 'ted' &&
    request.choices?.includes(failureChoices.fixed) &&
    request.choices.includes(failureChoices['no-longer-applicable'])
    ? [failureChoices.fixed, failureChoices['no-longer-applicable']]
    : []
}

function hasChoices(request: Comment): boolean {
  return request.kind === 'question' && (request.choices?.length ?? 0) > 0
}

function isFailure(request: Comment): boolean {
  return (
    request.purpose?.kind === 'failure' ||
    reasonChoicesOf(request).length > 0 ||
    request.choices?.includes('Wait for a repair Task') === true ||
    (request.choices?.includes(validateFailureChoices.retry) === true &&
      request.choices.includes(validateFailureChoices.fix))
  )
}

const failureWords = {
  legend: 'Your decision',
  otherLabel: 'Send a message to the Task Lead',
}

function Choices({
  request,
  failure,
  ...props
}: ComponentProps<typeof QuestionChoices> & { request: Comment; failure: boolean }) {
  return failure ? <FailureChoices request={request} {...props} /> : <QuestionChoices {...props} />
}

function FailureChoices({
  request,
  ...props
}: ComponentProps<typeof QuestionChoices> & { request: Comment }) {
  return (
    <QuestionChoices {...props} {...failureWords} recommended={useRecommendedChoice(request)} />
  )
}

function useSending(request: Comment, readOnly: boolean) {
  const sendingRef = useRef(false)
  const [sending, setSending] = useState(false)
  const [submission, setSubmission] = useState<AnswerRequest>()
  const [error, setError] = useState<string>()
  const [commenting, setCommenting] = useState(false)

  async function comment(body: string): Promise<boolean> {
    if (sendingRef.current || readOnly || body.trim() === '') return false
    sendingRef.current = true
    setCommenting(true)
    setSending(true)
    setError(undefined)
    try {
      await ted.postComment(request.taskId, { body, attachments: [] })
      return true
    } catch (failed) {
      setError(readableError(failed))
      return false
    } finally {
      sendingRef.current = false
      setSending(false)
      setCommenting(false)
    }
  }

  async function send(answer: AnswerRequest): Promise<boolean> {
    if (sendingRef.current || readOnly) return false
    sendingRef.current = true
    setSubmission(answer)
    setSending(true)
    setError(undefined)
    try {
      await ted.answerRequest(request.id, answer)
      return true
    } catch (failed) {
      setError(readableError(failed))
      return false
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  return {
    send,
    comment,
    commenting,
    sending,
    setSending,
    sendingRef,
    submission,
    setSubmission,
    error,
    setError,
  }
}

export type CommentInstead = { disabled: boolean; pending: boolean; send: () => void }

type AnswerProps = {
  request: Comment
  task: Task
  onOpenRun?: ((runId: string) => void) | undefined
  lead?: ((comment: CommentInstead) => ReactNode) | undefined
}

export function RequestAnswer(props: AnswerProps) {
  if (props.request.move) return <MoveAnswer {...props} />
  return props.request.archive ? <ArchiveAnswer {...props} /> : <QuestionAnswer {...props} />
}

function MoveAnswer({ request, task, lead }: AnswerProps) {
  const ask = request.move
  const kept = useMessageDraft({ kind: 'request', id: request.id })
  const { text, setText } = kept
  const { send: post, comment, commenting, sending, submission, error } = useSending(request, false)
  const factories = useFactories().filter((f) => f.id !== task.factoryId)
  const suggested = factories.find((f) => f.id === ask?.factoryId)
  const [picked, setFactoryId] = useState<string>()
  const factoryId = picked ?? suggested?.id
  const { plan, planError } = useMovePlan(task.id, factoryId, task.updatedAt, request.id)
  const chosen = factories.find((f) => f.id === factoryId)
  const asker = ask?.askedBy === 'coordinator' ? 'the Coordinator' : 'the Task Lead'
  const typed = text.trim() !== ''

  async function send(answer: AnswerRequest) {
    if (await post(answer)) kept.clear()
  }

  async function commentInstead() {
    if (await comment(text)) setText('')
  }

  return (
    <>
      {ask?.askedBy === 'coordinator' && (
        <p className={styles.caption}>Asked by the Coordinator.</p>
      )}
      <div className={dialogStyles.field}>
        <span aria-hidden>Factory</span>
        <FactoryPicker
          factories={factories}
          value={factoryId}
          onChange={setFactoryId}
          disabled={sending}
          empty="Choose a Factory"
        />
      </div>
      {suggested && chosen && chosen.id !== suggested.id && (
        <p className={styles.caption}>{`Suggested by ${asker}: ${suggested.name}.`}</p>
      )}
      {!suggested && ask && (
        <p className={styles.caption}>
          {`The Factory ${asker} suggested no longer exists. Choose another.`}
        </p>
      )}
      {planError !== undefined && (
        <p className={styles.error} role="alert">
          {planError}
        </p>
      )}
      {plan && <MovePlanDetails plan={plan} />}
      <textarea
        className={`${styles.box} ${grow.text}`}
        data-answer-box
        aria-label={`Message to ${asker}`}
        placeholder={`Add a message for ${asker}…`}
        value={text}
        disabled={sending}
        onChange={(event) => setText(event.target.value)}
      />
      {error !== undefined && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.buttons}>
        {lead?.({
          disabled: sending || !typed,
          pending: commenting,
          send: () => void commentInstead(),
        })}
        <Button
          pending={sending && submission?.action === 'answer' && submission.choice !== moveChoice}
          disabled={sending}
          onClick={() => send({ action: 'answer', choice: keepMoveChoice, ...(typed && { text }) })}
        >
          {keepMoveChoice}
        </Button>
        <Button
          variant={plan && !throwsAwayWork(plan) ? 'primary' : 'danger'}
          pending={sending && submission?.action === 'answer' && submission.choice === moveChoice}
          disabled={sending || !plan || plan.refusal !== undefined}
          onClick={() =>
            plan &&
            factoryId !== undefined &&
            send({
              action: 'answer',
              choice: moveChoice,
              ...(typed && { text }),
              move: { factoryId, planKey: movePlanKey(plan) },
            })
          }
        >
          {chosen ? `Move to ${chosen.name}` : moveChoice}
        </Button>
      </div>
    </>
  )
}

function ArchiveAnswer({ request, task, lead }: AnswerProps) {
  const boxId = useId()
  const kept = useMessageDraft({ kind: 'request', id: request.id })
  const { text, setText } = kept
  const { send: post, comment, commenting, sending, submission, error } = useSending(request, false)
  const all = useTasks()
  const under = all.filter((t) => !t.archived && isUnder(t, task.id, all))
  const blocked = useBlocked(task)
  const prs = openPullRequests(task)
  const advice = request.archive?.pullRequests
  const [close, setClose] = useState(advice?.recommend === 'close')
  const [dialog, setDialog] = useState(false)
  const asksUser = under.length > 0
  const typed = text.trim() !== ''

  async function send(answer: AnswerRequest) {
    if (await post(answer)) kept.clear()
  }

  async function commentInstead() {
    if (await comment(text)) setText('')
  }

  return (
    <>
      <p className={styles.caption}>
        Archiving stops the Task’s Runs and removes its worktree. Comments, the brief and the
        branches are kept, and you can unarchive it later.
      </p>
      {under.length > 0 && (
        <TaskNames
          heading={`${under.length === 1 ? 'Task' : 'Tasks'} under ${task.displayId}`}
          tasks={under}
        />
      )}
      {blocked.length > 0 && (
        <TaskNames
          heading={`Unblocks ${blocked.length} ${blocked.length === 1 ? 'Task' : 'Tasks'}`}
          tasks={blocked}
        />
      )}
      {prs.length > 0 && !asksUser && (
        <label className={dialogStyles.check}>
          <input
            type="checkbox"
            checked={close}
            disabled={sending}
            onChange={(event) => setClose(event.target.checked)}
          />
          <span>
            Close the pull {prs.length === 1 ? 'request' : 'requests'} on GitHub
            <span className={dialogStyles.checkNote}>
              {prs.map(({ repo, pr }) => `${repo.name} #${pr.number}`).join(', ')}
            </span>
          </span>
        </label>
      )}
      {prs.length > 0 && advice && (
        <p className={styles.caption}>
          {`The Task Lead recommends ${advice.recommend === 'close' ? 'closing' : 'keeping'} ${prs.length === 1 ? 'it' : 'them'}: ${advice.why}`}
        </p>
      )}
      {under.length > 0 && task.autopilot?.enabled === true && (
        <p className={styles.caption}>
          Autopilot is on, but this waits for you: archiving would archive the Tasks under{' '}
          {task.displayId} too.
        </p>
      )}
      <textarea
        id={boxId}
        className={`${styles.box} ${grow.text}`}
        data-answer-box
        aria-label="Message to the Task Lead"
        placeholder="Add a message for the Task Lead…"
        value={text}
        disabled={sending}
        onChange={(event) => setText(event.target.value)}
      />
      {error !== undefined && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.buttons}>
        {lead?.({
          disabled: sending || !typed,
          pending: commenting,
          send: () => void commentInstead(),
        })}
        <Button
          pending={
            sending && submission?.action === 'answer' && submission.choice !== archiveChoice
          }
          disabled={sending}
          onClick={() =>
            send({ action: 'answer', choice: keepArchiveChoice, ...(typed && { text }) })
          }
        >
          {keepArchiveChoice}
        </Button>
        <Button
          variant="primary"
          pending={
            sending && submission?.action === 'answer' && submission.choice === archiveChoice
          }
          disabled={sending}
          onClick={() =>
            asksUser
              ? setDialog(true)
              : send({
                  action: 'answer',
                  choice: archiveChoice,
                  ...(typed && { text }),
                  archive: { closePullRequests: prs.length > 0 && close },
                })
          }
        >
          {asksUser ? `${archiveChoice}…` : archiveChoice}
        </Button>
      </div>
      {dialog && (
        <ArchiveDialog
          task={task}
          request={{
            id: request.id,
            closePullRequests: advice?.recommend === 'close',
            ...(typed && { text }),
          }}
          onClose={() => setDialog(false)}
        />
      )}
    </>
  )
}

function isUnder(candidate: Task, rootId: string, all: readonly Task[]): boolean {
  const seen = new Set<string>()
  let parent = candidate.parentId
  while (parent !== undefined && !seen.has(parent)) {
    if (parent === rootId) return true
    seen.add(parent)
    parent = all.find((t) => t.id === parent)?.parentId
  }
  return false
}

function TaskNames({ heading, tasks }: { heading: string; tasks: readonly Task[] }) {
  return (
    <section className={styles.archiveList} aria-label={heading}>
      <h4 className={styles.archiveListHeading}>{heading}</h4>
      <ul>
        {tasks.map((t) => (
          <li key={t.id}>{`${t.displayId} ${t.title}`}</li>
        ))}
      </ul>
    </section>
  )
}

function useNamedRepair(task: Task, requestId: string) {
  const stages = useStages()
  const tasks = useTasks()
  const named = useFailures(task.id)
    .flatMap((f) => f.decisions)
    .find((d) => d.commentId === requestId)?.repairTask
  if (!named) return undefined
  const live = tasks.find((t) => t.id === named.id)
  const state = live
    ? live.archived
      ? 'Archived'
      : stages.name(live.stage, live.factoryId)
    : undefined
  return { ...named, choice: namedRepairChoice(named.displayId), state }
}

function NamedRepairNote({
  task,
  requestId,
  choice,
}: {
  task: Task
  requestId: string
  choice: string
}) {
  const named = useNamedRepair(task, requestId)
  if (!named || choice !== named.choice) return null
  return (
    <p className={styles.caption}>
      {task.displayId} keeps its Stage and worktree and waits for {named.displayId} · {named.title}{' '}
      to merge. Then Ted takes in the repair and runs fresh validation. {named.displayId} keeps its
      current state.
    </p>
  )
}

function NamedRepairTag({
  task,
  requestId,
  choice,
}: {
  task: Task
  requestId: string
  choice: string
}) {
  const named = useNamedRepair(task, requestId)
  if (!named || choice !== named.choice) return null
  return (
    <span className={styles.choiceTag}>
      {'· '}
      {named.title}
      {named.state !== undefined && ` · ${named.state}`}
    </span>
  )
}

function QuestionAnswer({ request, task, onOpenRun, lead }: AnswerProps) {
  const repairFormId = useId()
  const boxId = useId()
  const box: MessageBox = { kind: 'request', id: request.id }
  const kept = useMessageDraft(box)
  const savedOther = kept.fields.otherText
  const text = kept.text === '' && typeof savedOther === 'string' ? savedOther : kept.text
  const setText = (value: string) => {
    kept.setText(value)
    if (savedOther !== undefined) kept.setField('otherText', undefined)
  }
  const [selection, setSelection] = draftField(
    kept,
    'selection',
    undefined,
    (value): value is QuestionSelection | undefined =>
      value === undefined ||
      (value !== null &&
        typeof value === 'object' &&
        (('other' in value && value.other === true && !('picks' in value)) ||
          ('picks' in value &&
            Array.isArray(value.picks) &&
            value.picks.every((p) => (request.choices ?? []).includes(p)) &&
            (!('other' in value) || typeof value.other === 'boolean')) ||
          ('choice' in value &&
            typeof value.choice === 'string' &&
            (request.choices ?? []).includes(value.choice)))),
  )
  const {
    send: post,
    comment,
    commenting,
    sending,
    setSending,
    submission,
    error,
  } = useSending(request, false)
  const typed = text.trim() !== ''
  const simulators = useAskSlots(request)
  const [picked, setPicked] = useState<string>()
  const offered = simulators?.booted ?? request.simulator?.booted ?? []
  const chosen =
    picked !== undefined && offered.some((b) => b.udid === picked && !b.recording)
      ? picked
      : firstChoice(offered)
  const chosenOwner = offered.find((b) => b.udid === chosen)?.displayId

  async function send(answer: AnswerRequest) {
    if (await post(answer)) kept.clear()
  }

  const withText = typed ? { text } : {}
  const reasonChoices = reasonChoicesOf(request)
  const questionChoices = hasChoices(request)
  const several = request.multiple === true && questionChoices
  const picks = several && isSeveral(selection) ? selection.picks : []
  const selectedChoice = selection && 'choice' in selection ? selection.choice : undefined
  const kind = answerKind(request)
  const other =
    kind === 'open' &&
    (several
      ? isSeveral(selection) && selection.other === true
      : selection !== undefined && 'other' in selection)
  const needsReason = selectedChoice !== undefined && reasonChoices.includes(selectedChoice)
  const repairing = questionChoices && selectedChoice === 'Wait for a repair Task'
  const failure = isFailure(request)
  const textRefused = kind === 'choice-only' && typed
  const failureChoice = failure && questionChoices
  const boxLabel = !failureChoice
    ? undefined
    : needsReason
      ? selectedChoice === failureChoices.fixed
        ? 'Why is this failure fixed?'
        : 'Why does this failure no longer apply?'
      : other
        ? 'Message to the Task Lead'
        : undefined
  const ready = questionChoices
    ? !repairing &&
      (several
        ? !other || typed
        : selectedChoice !== undefined
          ? !textRefused && (!needsReason || typed)
          : other && typed)
    : typed

  const enter = request.simulator
    ? chosen !== undefined && 'approve'
    : request.permission
      ? 'approve'
      : request.gate
        ? signOffEnter(typed)
        : ready && 'answer'

  function approve() {
    const removeAgents = request.design?.setup?.agents ? removedAgentsDraft(kept) : []
    return send({
      action: 'approve',
      ...(request.simulator && chosen !== undefined && { simulator: chosen }),
      ...(removeAgents.length > 0 && { removeAgents }),
      ...withText,
    })
  }

  function sendAnswer() {
    if (!ready || sending) return
    return send(
      request.gate
        ? { action: 'request-changes', text }
        : {
            action: 'answer',
            ...(questionChoices && selectedChoice !== undefined && { choice: selectedChoice }),
            ...(several && (picks.length > 0 || !other) && { choices: picks }),
            ...(typed && { text }),
          },
    )
  }

  async function commentInstead() {
    if (!(await comment(text))) return
    setText('')
  }

  function pressEnter() {
    if (sending || enter === false) return
    if (enter === 'approve') return approve()
    return sendAnswer()
  }

  return (
    <>
      {request.simulator && (
        <SimulatorRequest request={request} readOnly={false} chosen={chosen} onChoose={setPicked} />
      )}
      {questionChoices && (
        <Choices
          request={request}
          failure={failure}
          choices={request.choices ?? []}
          multiple={several}
          selection={selection}
          onSelect={setSelection}
          allowOther={kind === 'open'}
          disabled={sending}
          tagOf={(choice) =>
            failure &&
            choice.startsWith('Wait for ') &&
            choice !== 'Wait for a repair Task' && (
              <NamedRepairTag task={task} requestId={request.id} choice={choice} />
            )
          }
        />
      )}
      {boxLabel !== undefined && (
        <label className={styles.boxLabel} htmlFor={boxId}>
          {boxLabel}
        </label>
      )}
      {!isTrackerGroupAsk(request) && (
        <textarea
          id={boxId}
          className={`${styles.box} ${grow.text}`}
          data-answer-box
          form={repairing ? repairFormId : undefined}
          aria-label={boxLabel ?? 'Your answer'}
          placeholder={
            request.simulator
              ? 'Comment…'
              : needsReason
                ? 'Explain what changed…'
                : request.permission
                  ? 'Comment, or say why you’re denying…'
                  : request.design || request.gate
                    ? 'Comment, or say what to change…'
                    : kind === 'choice-only'
                      ? 'Comment…'
                      : questionChoices
                        ? other
                          ? failure
                            ? 'Ask a question or add context…'
                            : 'Your answer…'
                          : 'Add to this answer…'
                        : 'Comment to the Task Lead…'
          }
          value={text}
          disabled={sending}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) =>
            repairing
              ? sendOnEnter(
                  () => event.currentTarget.form?.requestSubmit(),
                  () => !sending,
                )(event)
              : sendOnEnter(pressEnter, () => true)(event)
          }
        />
      )}
      {textRefused && (
        <p className={styles.caption}>
          This question takes only its buttons. Send the text with Comment without answering.
        </p>
      )}
      {needsReason && (
        <p className={styles.caption}>A reason is required. Confirming closes this failure.</p>
      )}
      {failureChoice && selectedChoice?.startsWith('Wait for ') && !repairing && (
        <NamedRepairNote task={task} requestId={request.id} choice={selectedChoice} />
      )}
      {failureChoice && other && (
        <p className={styles.caption}>
          Sending a message leaves this failure open. Choose a decision to resolve it.
        </p>
      )}
      {questionChoices && request.choices?.includes('Wait for a repair Task') && (
        <div hidden={!repairing}>
          <FailureRepairForm
            id={repairFormId}
            active={repairing}
            task={task}
            request={request}
            reason={text}
            box={box}
            onCancel={() => setSelection(undefined)}
            onSendingChange={setSending}
          />
        </div>
      )}
      {error !== undefined && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.buttons}>
        {lead?.({
          disabled: sending || !typed,
          pending: commenting,
          send: () => void commentInstead(),
        })}
        {request.failed && onOpenRun && (
          <ActionButton
            type="button"
            className={styles.openRun}
            onClick={() => onOpenRun(request.failed?.runId ?? '')}
          >
            Open last Run
          </ActionButton>
        )}
        {request.gate?.caption !== undefined &&
          (request.stage === 'clarify' ? (
            <span className={styles.caption}>{request.gate.caption}</span>
          ) : (
            <Help>{request.gate.caption}</Help>
          ))}
        {request.simulator ? (
          <>
            <Button disabled={sending} onClick={() => send({ action: 'deny', ...withText })}>
              Deny
            </Button>
            <Button
              variant="primary"
              shortcut="↵"
              disabled={sending || chosen === undefined}
              onClick={approve}
            >
              {chosenOwner !== undefined ? `Shut down ${chosenOwner}’s and run` : 'Run'}
            </Button>
          </>
        ) : request.permission ? (
          <>
            <Button disabled={sending} onClick={() => send({ action: 'deny', ...withText })}>
              Deny
            </Button>
            <Button
              variant="primary"
              arm="approve"
              shortcut="↵"
              pending={sending && submission?.action === 'approve'}
              disabled={sending}
              onClick={approve}
            >
              Approve
            </Button>
          </>
        ) : request.gate ? (
          <>
            <Button
              data-request-changes
              {...(enter === 'request-changes' && { shortcut: '↵' })}
              pending={sending && submission?.action === 'request-changes'}
              disabled={sending || !typed}
              onClick={() => send({ action: 'request-changes', text })}
            >
              Request changes
            </Button>
            <Button
              variant="primary"
              arm="approve"
              {...(enter === 'approve' && { shortcut: '↵' })}
              pending={sending && submission?.action === 'approve'}
              disabled={sending}
              onClick={approve}
            >
              {request.gate.approveLabel}
            </Button>
          </>
        ) : !repairing ? (
          <>
            {request.failed && (
              <Help>
                Choose Retry to start a fresh Task Lead Run from the brief, or Other answer to leave
                a comment for the next Run. Send confirms your choice.
              </Help>
            )}
            <Button
              variant="primary"
              shortcut="↵"
              disabled={sending || !ready}
              pending={sending && submission?.action === 'answer'}
              onClick={sendAnswer}
            >
              {failureChoice && selectedChoice !== undefined
                ? `Confirm ${selectedChoice}`
                : failureChoice && other
                  ? 'Send message'
                  : 'Send'}
            </Button>
          </>
        ) : null}
      </div>
    </>
  )
}

export function dockable(request: Comment): boolean {
  return !request.round && !request.proposal
}

export function RequestCard({
  request,
  task,
  readOnly = false,
  active = true,
  answerBelow = false,
  onOpenRun,
  onOpenTask,
  onOpenApp,
  taskChanges,
  onOpenFile,
  onAllChanges,
}: {
  request: Comment
  task: Task
  taskChanges?: TaskChanges | undefined
  onOpenFile?: ((file: ChangedFile) => void) | undefined
  onAllChanges?: (() => void) | undefined
  readOnly?: boolean
  active?: boolean
  answerBelow?: boolean
  onOpenRun?: ((runId: string) => void) | undefined
  onOpenTask?: ((id: string) => void) | undefined
  onOpenApp?: ((app: ShownApp) => void) | undefined
}) {
  const [confirmTalk, setConfirmTalk] = useState(false)
  const [openWhenReady, setOpenWhenReady] = useState(false)
  const pendingTalkSeen = useRef(false)
  const previousTalkStartedAt = useRef<string>(undefined)
  const navigation = useRef(0)
  useEffect(() => {
    if (!active) navigation.current += 1
  }, [active])
  const activeRef = useRef(active)
  activeRef.current = active
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!openWhenReady) return
    if (!active || request.answer || task.archived) {
      setOpenWhenReady(false)
      return
    }
    if (request.talkRequested) {
      pendingTalkSeen.current = true
      return
    }
    if (
      request.talk &&
      request.talk.runId === task.leadRunId &&
      request.talk.notifiedAt !== undefined &&
      request.talk.startedAt !== previousTalkStartedAt.current
    ) {
      setOpenWhenReady(false)
      onOpenRun?.(request.talk.runId)
    } else if (pendingTalkSeen.current) setOpenWhenReady(false)
  }, [active, openWhenReady, request, task, onOpenRun])
  const waitingLead = task.runs.find((run) => run.id === task.leadRunId && run.state !== 'finished')
  const talkWaitReason = waitingLead
    ? (waitingLead.paused ??
      (request.talk?.runId === waitingLead.id
        ? 'Waiting for the Task Lead to receive this request.'
        : 'Waiting for the Task Lead’s Provider or model to be available.'))
    : task.activity || 'Waiting for a free slot or for the Provider to be available.'
  const now = useNow()
  const { send, sending, setSending, sendingRef, setSubmission, error, setError } = useSending(
    request,
    readOnly,
  )
  const box: MessageBox | undefined =
    readOnly || request.answer !== undefined ? undefined : { kind: 'request', id: request.id }
  const shown =
    request.permission && request.body.trim() === ''
      ? 'The agent didn’t provide an explanation for this request.'
      : summary(request)
  const [showingPrevious, setShowingPrevious] = useState(false)
  const changes = request.gate?.changes
  const rows = request.gate?.pullRequests
  const below = answerBelow && !readOnly && dockable(request)
  const failure = isFailure(request)

  async function talk(confirmResume = false) {
    if (sendingRef.current) return
    sendingRef.current = true
    setSubmission(undefined)
    setSending(true)
    setError(undefined)
    const requestedFrom = navigation.current
    try {
      previousTalkStartedAt.current = request.talk?.startedAt
      pendingTalkSeen.current = false
      const talking = await ted.talkThrough(request.id, { confirmResume })
      if (!mounted.current || !activeRef.current || requestedFrom !== navigation.current) return
      if ('resumeRequired' in talking) setConfirmTalk(true)
      else if (talking.talkRequested) setOpenWhenReady(true)
      else if (talking.talk && !talking.answer) onOpenRun?.(talking.talk.runId)
    } catch (failed) {
      setError(readableError(failed))
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  return (
    <section
      className={[
        styles.card,
        ...(request.failed ? [styles.failedCard] : []),
        ...(readOnly ? [styles.readOnly] : []),
      ].join(' ')}
      aria-label={readOnly ? `${requestLabel(request)}, read-only` : requestLabel(request)}
      data-request={!readOnly && !below && request.answer === undefined ? request.id : undefined}
      data-docked={below && request.answer === undefined ? request.id : undefined}
    >
      <div className={styles.headRow}>
        <CardHead request={request} task={task} now={now} />
        {changes && !rows && !readOnly && (
          <ActionButton
            type="button"
            className={styles.showRequest}
            aria-expanded={showingPrevious}
            onClick={() => setShowingPrevious(!showingPrevious)}
          >
            {`${showingPrevious ? 'Hide' : 'View'} previously approved ${request.stage === 'review' ? 'review' : 'sign-off'}`}
          </ActionButton>
        )}
      </div>
      {showingPrevious && changes && !rows && (
        <PreviouslyApprovedSignOff id={changes.since} task={task} />
      )}
      {!readOnly && request.answer === undefined && <RequestSnoozeLine requestId={request.id} />}
      <h2 className={styles.title}>
        <ReferenceText text={headline(request)} />
      </h2>
      {rows && <MergeRows rows={rows} taskId={task.id} noCi={request.gate?.noCi ?? []} />}
      {!rows && request.gate?.noCi && <NoCiLines names={request.gate.noCi} />}
      {request.gate?.sandboxAccess && (
        <AccessChanges
          title="Sandbox access changes in .ted/workflow.yaml"
          changes={request.gate.sandboxAccess}
        />
      )}
      {request.gate?.sandboxAccessUnknown && <AccessUnknown />}
      {rows && changes && <MergeChangesLine changes={changes} />}
      {changes && !rows && <ChangesBlock changes={changes} current={taskChanges} />}
      {request.kind === 'signoff' &&
        request.stage === 'review' &&
        (readOnly ? (
          <ConfirmationRow request={request} task={task} readOnly />
        ) : (
          <CurrentConfirmationRow request={request} task={task} />
        ))}
      {request.design && Object.keys(request.design).length > 0 ? (
        <DesignReviewContent
          design={request.design}
          files={request.attachments ?? []}
          taskId={task.id}
          commentId={request.id}
          box={box}
          answeredRemoved={
            request.answer?.kind === 'approved' ? (request.answer.removedAgents ?? []) : undefined
          }
        />
      ) : failure ? (
        <FailureRequestDetails
          taskId={task.id}
          requestId={request.id}
          fallback={request.body}
          onOpenTask={onOpenTask}
          noAccept={
            !request.answer &&
            request.choices !== undefined &&
            !request.choices.includes(failureChoices.accepted)
          }
          closable={
            request.choices?.includes(failureChoices.fixed) === true &&
            request.choices.includes(failureChoices['no-longer-applicable'])
          }
        />
      ) : request.gate && request.stage === 'clarify' ? (
        <SignoffDecisions text={request.body} />
      ) : request.gate ? (
        request.body.trim() !== '' && (
          <BriefSections text={request.body} title={headline(request)} />
        )
      ) : (
        shown !== undefined && shown !== '' && <Markdown text={shown} />
      )}
      {request.kind === 'signoff' &&
        request.stage === 'review' &&
        !readOnly &&
        onOpenFile &&
        onAllChanges && (
          <ReviewChanges
            changes={taskChanges}
            since={changes}
            onOpen={onOpenFile}
            onAll={onAllChanges}
          />
        )}
      {request.kind === 'signoff' && request.stage === 'review' && !readOnly && (
        <PreviewRow task={task} onOpenApp={onOpenApp} />
      )}
      {confirmTalk && (
        <Dialog onClose={() => setConfirmTalk(false)}>
          {(headingId) => (
            <>
              <h2 id={headingId} className={dialogStyles.heading}>
                Resume Task to talk?
              </h2>
              <p className={dialogStyles.body}>
                You stopped this Task. Resume its Task Lead to talk through this round. Your answers
                will stay as they are.
              </p>
              <div className={dialogStyles.buttons}>
                <Button onClick={() => setConfirmTalk(false)}>Cancel</Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    setConfirmTalk(false)
                    void talk(true)
                  }}
                >
                  Resume and talk
                </Button>
              </div>
            </>
          )}
        </Dialog>
      )}
      {request.talkRequested && !request.answer && !readOnly && (
        <p className={styles.summary} role="status">
          Waiting for Task Lead… {talkWaitReason}
        </p>
      )}
      {request.round && (
        <RoundQuestions
          round={request.round}
          waiting={request.talkRequested === true}
          readOnly={readOnly}
          sending={sending}
          talking={request.talk?.notifiedAt !== undefined && request.talk.runId === task.leadRunId}
          onSend={(answer) => void send(answer)}
          onTalk={onOpenRun && (() => void talk())}
          box={box}
        />
      )}
      {request.proposal &&
        (readOnly ? (
          <ProposalRows
            proposal={request.proposal}
            skip={(request.answer?.kind === 'approved' && request.answer.created?.skipped) || []}
            created={request.answer?.kind === 'approved' ? request.answer.created : undefined}
            disabled
          />
        ) : (
          <ProposalAnswer
            proposal={request.proposal}
            readOnly={readOnly}
            sending={sending}
            box={box}
            onSend={(answer) => send(answer)}
          />
        ))}
      {request.sizeCheck && (
        <section className={styles.content} aria-label="A plan needs to settle">
          <h3 className={styles.sectionHeading}>A plan needs to settle</h3>
          <ul className={styles.decisions}>
            {request.sizeCheck.settle.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </section>
      )}
      {(request.round || request.proposal) && error !== undefined && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <PermissionCommand request={request} />
      {readOnly && request.simulator && (
        <SimulatorRequest
          request={request}
          readOnly
          chosen={firstChoice(request.simulator.booted)}
          onChoose={() => {}}
        />
      )}
      {readOnly && hasChoices(request) && (
        <Choices
          request={request}
          failure={failure}
          choices={request.choices ?? []}
          selection={undefined}
          onSelect={() => {}}
          allowOther={answerKind(request) === 'open'}
          disabled
        />
      )}
      {below ? (
        <p className={styles.below}>Answer at the bottom of the Task ↓</p>
      ) : (
        !readOnly &&
        dockable(request) && <RequestAnswer request={request} task={task} onOpenRun={onOpenRun} />
      )}
    </section>
  )
}

function FactoryName({ id }: { id: string }) {
  const factories = useFactories()
  return factories.some((f) => f.id === id) ? (
    <NamedFactory factories={factories} factoryId={id} />
  ) : (
    'another Factory'
  )
}

function answerLine(
  request: Comment,
  newer: Comment | undefined,
  task: Task,
  stages: Stages,
): { mark: string; tone: string; text: string; factoryId?: string } | undefined {
  const { answer } = request
  if (!answer) return undefined
  if (request.autopilotAnswered)
    return {
      mark: '✓',
      tone: 'good',
      text: answer.kind === 'approved' ? 'Autopilot approved' : 'Autopilot answered',
    }
  switch (answer.kind) {
    case 'approved':
      if (answer.created) {
        const count = answer.created.tasks.length
        return {
          mark: '✓',
          tone: 'good',
          text: `You approved · created ${count} ${count === 1 ? 'Task' : 'Tasks'}`,
        }
      }
      return {
        mark: '✓',
        tone: 'good',
        text:
          answer.shutDown !== undefined
            ? `You shut down ${answer.shutDown}’s ${request.simulator?.platform === 'android' ? 'emulator' : 'simulator'}`
            : request.permission
              ? 'You approved · this request only'
              : 'You approved',
      }
    case 'denied':
      return { mark: '✕', tone: 'bad', text: 'You denied' }
    case 'changes-requested':
      return { mark: '↩', tone: 'neutral', text: 'You requested changes' }
    case 'answered':
      if (answer.talkedThrough) {
        const { messages } = answer.talkedThrough
        return {
          mark: '✓',
          tone: 'good',
          text: `Answered in Talk it through · ${messages} ${messages === 1 ? 'message' : 'messages'}`,
        }
      }
      if (answer.answers) {
        return { mark: '✓', tone: 'good', text: `You answered · ${roundTally(answer.answers)}` }
      }
      if (answer.choices !== undefined) {
        const picked = answer.choices.length > 0 ? answer.choices.join(', ') : noChoicesPicked
        return { mark: '✓', tone: 'good', text: `You answered: ${picked}` }
      }
      return answer.choice !== undefined
        ? { mark: '✓', tone: 'good', text: `You answered: ${answer.choice}` }
        : { mark: '✓', tone: 'good', text: 'You replied in your own words' }
    case 'withdrawn':
      if ('runStopped' in answer) {
        return {
          mark: '–',
          tone: 'neutral',
          text: `Withdrawn · ${runOwner(request, task)} Run stopped before you answered`,
        }
      }
      if ('cancelled' in answer) {
        return { mark: '–', tone: 'neutral', text: 'Withdrawn · the agent no longer needs it' }
      }
      if ('slotFreed' in answer) {
        return {
          mark: '–',
          tone: 'neutral',
          text: `${request.simulator?.platform === 'android' ? 'An emulator' : 'A simulator'} freed up; nothing was shut down`,
        }
      }
      if ('appGone' in answer) {
        return {
          mark: '–',
          tone: 'neutral',
          text: 'Withdrawn · the App stopped before you answered',
        }
      }
      if ('linear' in answer) {
        return {
          mark: '–',
          tone: 'neutral',
          text:
            answer.linear === 'reopened'
              ? 'Withdrawn · the Linear issue was reopened before you answered'
              : 'Withdrawn · the Task merged before you answered',
        }
      }
      if ('tracker' in answer) {
        const name = request.purpose?.kind === 'tracker-closed' ? request.purpose.tracker : ''
        return {
          mark: '–',
          tone: 'neutral',
          text:
            answer.tracker === 'reopened'
              ? `Withdrawn · the ${trackerName(name)} item was reopened before you answered`
              : 'Withdrawn · the Task merged before you answered',
        }
      }
      if ('ciReported' in answer) {
        return { mark: '–', tone: 'neutral', text: 'Withdrawn · CI reported before you answered' }
      }
      if ('asanaReread' in answer) {
        return {
          mark: '–',
          tone: 'neutral',
          text: 'Withdrawn · Ted read Asana again and asked anew',
        }
      }
      if ('archived' in answer) {
        return {
          mark: '–',
          tone: 'neutral',
          text: 'Withdrawn · the Task was archived before you answered',
        }
      }
      if ('movedToFactory' in answer) {
        return {
          mark: '–',
          tone: 'neutral',
          text: 'Withdrawn · the Task moved to ',
          factoryId: answer.movedToFactory,
        }
      }
      return {
        mark: '–',
        tone: 'neutral',
        text: `Withdrawn · the Task went ${
          request.stage !== undefined &&
          stages.index(answer.movedTo, task.factoryId) < stages.index(request.stage, task.factoryId)
            ? 'back'
            : 'on'
        } to ${stages.name(answer.movedTo, task.factoryId)} before you answered`,
      }
    case 'superseded': {
      const by = newer ?? request
      return {
        mark: '↻',
        tone: 'neutral',
        text: `Superseded by a newer ${kindLabels[by.kind].toLowerCase()} from ${poster(by, task)}`,
      }
    }
  }
}

function runOwner(request: Comment, task: Task): string {
  const who = poster(request, task)
  return who === 'the Task Lead'
    ? 'the Task Lead’s'
    : who === 'a sub-agent'
      ? 'the sub-agent’s'
      : 'its'
}

const outcomes: Partial<Record<CommentAnswer['kind'], string>> = {
  withdrawn: 'withdrawn',
  superseded: 'superseded',
}

function ReplyProgress({
  request,
  task,
  now,
  onOpenRun,
}: {
  request: Comment
  task: Task
  now: number
  onOpenRun?: ((runId: string) => void) | undefined
}) {
  if (
    request.kind !== 'question' ||
    request.answer?.kind !== 'answered' ||
    request.author.kind !== 'run' ||
    (request.purpose && request.purpose.kind !== 'question') ||
    request.gate ||
    request.sizeCheck
  )
    return null
  const receipt = request.answerDelivery
  const lead = task.runs.find((run) => run.id === task.leadRunId)
  const activity =
    lead?.paused !== undefined
      ? `Task Lead paused · ${lead.paused}`
      : task.status?.kind === 'paused'
        ? `Task Lead paused · ${task.status.reason}`
        : lead?.state === 'working'
          ? lead.onSubAgents
            ? 'Task Lead waiting for sub-agents'
            : 'Task Lead working'
          : lead?.state === 'waiting'
            ? 'Task Lead waiting'
            : lead?.state === 'idle'
              ? 'Task Lead idle'
              : 'Task Lead stopped'
  const runId = task.leadRunId ?? receipt?.sent?.runId ?? request.author.runId
  return (
    <section className={styles.replyProgress} aria-label="Reply delivery">
      <div>
        <span>
          {receipt?.sent
            ? 'Sent to Task Lead'
            : receipt
              ? 'Waiting to reach Task Lead'
              : 'Delivery not recorded'}
        </span>
        {receipt && (
          <span className={styles.answerAge}>
            {' '}
            · {ago(receipt.sent?.at ?? receipt.queuedAt, now)}
          </span>
        )}
      </div>
      <div className={styles.replyActivity}>
        <span>{activity}</span>
        {onOpenRun && (
          <Button variant="quiet" size="small" onClick={() => onOpenRun(runId)}>
            Open conversation
          </Button>
        )}
      </div>
    </section>
  )
}

export function AnsweredCard({
  request,
  task,
  newer,
  expanded = false,
  onOpenRun,
  onOpenTask,
}: {
  request: Comment
  task: Task
  newer?: Comment | undefined
  expanded?: boolean
  onOpenRun?: ((runId: string) => void) | undefined
  onOpenTask?: ((id: string) => void) | undefined
}) {
  const now = useNow()
  const stages = useStages()
  const permission = request.kind === 'permission'
  const shown =
    request.permission && request.body.trim() === ''
      ? 'The agent didn’t provide an explanation for this request.'
      : summary(request)
  const [showing, setShowing] = useState(expanded)
  const card = useRef<HTMLElement>(null)
  useEffect(() => {
    if (expanded) card.current?.scrollIntoView({ block: 'nearest' })
  }, [expanded])
  const line = answerLine(request, newer, task, stages)
  const quoted = request.answer && 'text' in request.answer ? request.answer.text : undefined
  const outcome = (request.answer && outcomes[request.answer.kind]) ?? 'answered'
  const talked = request.answer?.kind === 'answered' ? request.answer.talkedThrough : undefined
  return (
    <section
      ref={card}
      className={styles.answered}
      aria-label={`${requestLabel(request)}, ${outcome}`}
    >
      <div className={styles.answeredHead}>
        <CardHead request={request} task={task} now={now} />
        {talked && onOpenRun ? (
          <ActionButton
            type="button"
            className={styles.showRequest}
            onClick={() => onOpenRun(talked.runId)}
          >
            Open chat
          </ActionButton>
        ) : !permission ? (
          <ActionButton
            type="button"
            className={styles.showRequest}
            aria-expanded={showing}
            onClick={() => setShowing(!showing)}
          >
            {showing ? 'Hide request' : 'Show request'}
          </ActionButton>
        ) : null}
      </div>
      {permission ? (
        <>
          <h2 className={styles.title}>
            <ReferenceText text={headline(request)} />
          </h2>
          {shown !== undefined && shown !== '' && <Markdown text={shown} />}
          <PermissionCommand request={request} />
          {request.simulator && (
            <SimulatorRequest
              request={request}
              readOnly
              chosen={firstChoice(request.simulator.booted)}
              onChoose={() => {}}
            />
          )}
        </>
      ) : (
        <p className={styles.answeredTitle}>
          <ReferenceText text={headline(request)} />
        </p>
      )}
      {request.answer?.kind === 'answered' && request.answer.answers && (
        <RoundAnswers request={request} answers={request.answer.answers} />
      )}
      {request.proposal && request.answer?.kind === 'approved' && request.answer.created && (
        <ProposalRows
          proposal={request.proposal}
          skip={request.answer.created.skipped}
          created={request.answer.created}
          disabled
        />
      )}
      {line && request.answer && (
        <div className={styles.answerLine}>
          <span className={styles[line.tone]} aria-hidden>
            {line.mark}
          </span>
          <span className={styles.answerText}>
            {line.text}
            {line.factoryId !== undefined && <FactoryName id={line.factoryId} />}
          </span>
          <span className={styles.answerAge}>{ago(request.answer.at, now)}</span>
        </div>
      )}
      {quoted !== undefined && quoted !== '' && (
        <blockquote className={styles.quote}>
          <Markdown text={quoted} />
        </blockquote>
      )}
      <ReplyProgress request={request} task={task} now={now} onOpenRun={onOpenRun} />
      {!permission && showing && (
        <RequestCard request={request} task={task} onOpenTask={onOpenTask} readOnly />
      )}
    </section>
  )
}
