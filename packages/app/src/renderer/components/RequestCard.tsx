import type {
  AnswerRequest,
  Comment,
  CommentAnswer,
  MergeRow,
  SignOffChanges,
  Task,
  TaskChanges,
  ValidationProgress,
} from '@ted/protocol'
import { failureChoices, validateFailureChoices } from '@ted/protocol/failures'
import { useEffect, useId, useRef, useState } from 'react'
import type { ChangedFile } from '../changes.ts'
import { sendOnEnter } from '../composer-keys.ts'
import {
  useCheckRuns,
  useComments,
  useSimulators,
  useThreadEvents,
  useValidationObligations,
} from '../data.ts'
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
import { readableError, ted } from '../ted.ts'
import { formatDate } from '../time.ts'
import { stageName } from '../views/TaskViews.tsx'
import { ActionButton } from './ActionButton.tsx'
import type { ShownApp } from './AppsSection.tsx'
import { Button } from './Button.tsx'
import { ChangeList } from './ChangesSection.tsx'
import { CheckOutputDialog } from './CheckOutputDialog.tsx'
import { ChecksRow } from './ChecksRow.tsx'
import { DesignReviewContent } from './DesignReview.tsx'
import {
  FailureRequestDetails,
  RecordedValidationSummary,
  ValidationSummary,
} from './FailureDetails.tsx'
import { FailureRepairForm } from './FailureRepairForm.tsx'
import { Help } from './Help.tsx'
import { Markdown } from './Markdown.tsx'
import { PreviewRow } from './PreviewRow.tsx'
import { ProposalAnswer, ProposalRows } from './ProposalCard.tsx'
import { QuestionChoices, type QuestionSelection } from './QuestionChoices.tsx'
import styles from './RequestCard.module.css'
import { RequestSnoozeLine } from './RequestSnooze.tsx'
import { RoundAnswers, RoundQuestions, roundTally } from './RoundCard.tsx'
import { firstChoice, SimulatorChoices } from './SimulatorChoices.tsx'

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

function MergeRows({ rows, taskId }: { rows: readonly MergeRow[]; taskId: string }) {
  const several = rows.length > 1
  return (
    <>
      <p className={styles.summary}>
        {several
          ? `CI passed and ${rows.length === 2 ? 'both' : 'all'} are mergeable. They merge in this order.`
          : 'CI passed and it’s mergeable.'}
      </p>
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
                  `${row.checks.failed === 0 && row.checks.pending === 0 ? '✓ ' : ''}${checksSummary(row.checks)}`,
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
  return (
    <section className={styles.changes} aria-label="Since your last approval">
      <h3 className={styles.sectionHeading}>Since your last approval</h3>
      {changes.summary !== undefined && (
        <Markdown className={styles.sectionBody} text={changes.summary} />
      )}
      <ul className={styles.changedFiles}>
        {changes.repos.flatMap((repo) =>
          repo.files.length === 0
            ? [
                <li key={repo.name} className={styles.changedFile}>
                  <span className={styles.changedRepo}>{repo.name}</span>
                  <span className={styles.noChanges}>
                    {repo.unavailable ? 'TED couldn’t compare this repo' : 'no changes'}
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
        )}
      </ul>
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
            <ChangeList changes={changes} onOpen={onOpen} since={since} />
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
  const live = useSimulators()
  const ask = request.simulator
  if (!ask) return null
  const booted = !readOnly && live?.supported === true ? live.booted : ask.booted
  return (
    <SimulatorChoices
      booted={booted}
      chosen={chosen}
      onChoose={onChoose}
      now={now}
      label="Simulator to shut down"
      showApp
      disabled={readOnly}
    />
  )
}

export function RequestCard({
  request,
  task,
  readOnly = false,
  onOpenRun,
  onOpenTask,
  onOpenApp,
  onOpenPlan,
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
  onOpenRun?: ((runId: string) => void) | undefined
  onOpenTask?: ((id: string) => void) | undefined
  onOpenApp?: ((app: ShownApp) => void) | undefined
  onOpenPlan?: ((planId: string) => void) | undefined
}) {
  const now = useNow()
  const repairFormId = useId()
  const boxId = useId()
  const [selection, setSelection] = useState<QuestionSelection>()
  const [otherText, setOtherText] = useState('')
  const sendingRef = useRef(false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [submission, setSubmission] = useState<AnswerRequest>()
  const [error, setError] = useState<string>()
  const shown =
    request.permission && request.body.trim() === ''
      ? 'The agent didn’t provide an explanation for this request.'
      : summary(request)
  const typed = text.trim() !== ''
  const [showingPrevious, setShowingPrevious] = useState(false)
  const simulators = useSimulators()
  const [picked, setPicked] = useState<string>()
  const offered = simulators?.booted ?? request.simulator?.booted ?? []
  const chosen =
    picked !== undefined && offered.some((b) => b.udid === picked && !b.recording)
      ? picked
      : firstChoice(offered)
  const chosenOwner = offered.find((b) => b.udid === chosen)?.displayId
  const changes = request.gate?.changes
  const rows = request.gate?.pullRequests

  async function send(answer: AnswerRequest) {
    if (sendingRef.current || readOnly) return
    sendingRef.current = true
    setSubmission(answer)
    setSending(true)
    setError(undefined)
    try {
      const answered = await ted.answerRequest(request.id, answer)
      setText('')
      setOtherText('')
      if (answered.answer?.kind === 'answered' && answered.answer.planId !== undefined) {
        onOpenPlan?.(answered.answer.planId)
      }
    } catch (failed) {
      setError(readableError(failed))
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  async function talk() {
    if (sendingRef.current) return
    sendingRef.current = true
    setSubmission(undefined)
    setSending(true)
    setError(undefined)
    try {
      const talking = await ted.talkThrough(request.id)
      if (talking.talk) onOpenRun?.(talking.talk.runId)
    } catch (failed) {
      setError(readableError(failed))
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  const withText = typed ? { text } : {}
  const reasonChoices: string[] =
    request.author.kind === 'ted' &&
    request.choices?.includes(failureChoices.fixed) &&
    request.choices.includes(failureChoices['no-longer-applicable'])
      ? [failureChoices.fixed, failureChoices['no-longer-applicable']]
      : []
  const questionChoices = request.kind === 'question' && (request.choices?.length ?? 0) > 0
  const selectedChoice = selection && 'choice' in selection ? selection.choice : undefined
  const other = selection && 'other' in selection
  const needsReason = selectedChoice !== undefined && reasonChoices.includes(selectedChoice)
  const repairing = questionChoices && selectedChoice === 'Wait for a repair Task'
  const failure =
    request.purpose?.kind === 'failure' ||
    reasonChoices.length > 0 ||
    request.choices?.includes('Wait for a repair Task') === true ||
    (request.choices?.includes(validateFailureChoices.retry) === true &&
      request.choices.includes(validateFailureChoices.fix))
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
  const answerText = questionChoices && other ? otherText : text
  const ready = questionChoices
    ? !repairing &&
      (selectedChoice !== undefined ? !needsReason || typed : other && otherText.trim() !== '')
    : typed

  function sendAnswer() {
    if (!ready || sending || readOnly) return
    return send(
      request.gate
        ? { action: 'request-changes', text }
        : {
            action: 'answer',
            ...(questionChoices && selectedChoice !== undefined && { choice: selectedChoice }),
            ...(answerText.trim() !== '' && { text: answerText }),
          },
    )
  }

  return (
    <section
      className={[
        styles.card,
        ...(request.failed ? [styles.failedCard] : []),
        ...(readOnly ? [styles.readOnly] : []),
      ].join(' ')}
      aria-label={readOnly ? `${requestLabel(request)}, read-only` : requestLabel(request)}
      data-request={!readOnly && request.answer === undefined ? request.id : undefined}
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
      <h2 className={styles.title}>{headline(request)}</h2>
      {rows && <MergeRows rows={rows} taskId={task.id} />}
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
      {request.round && (
        <RoundQuestions
          round={request.round}
          readOnly={readOnly}
          sending={sending}
          talking={request.talk !== undefined}
          onSend={(answer) => send(answer)}
          onTalk={onOpenRun && (() => talk())}
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
      {request.simulator && (
        <SimulatorRequest
          request={request}
          readOnly={readOnly}
          chosen={chosen}
          onChoose={setPicked}
        />
      )}
      {questionChoices && (
        <QuestionChoices
          choices={request.choices ?? []}
          selection={selection}
          onSelect={setSelection}
          allowOther={!request.linearTeam}
          disabled={sending || readOnly}
          {...(failure && {
            legend: 'Your decision',
            otherLabel: 'Send a message to the Task Lead',
          })}
        />
      )}
      {!readOnly && !request.round && !request.proposal && (
        <>
          {boxLabel !== undefined && (
            <label className={styles.boxLabel} htmlFor={boxId}>
              {boxLabel}
            </label>
          )}
          {!request.linearTeam && (
            <textarea
              id={boxId}
              className={styles.box}
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
                      : request.design
                        ? 'Comment, or say what to change…'
                        : questionChoices
                          ? other
                            ? failure
                              ? 'Ask a question or add context…'
                              : 'Your answer…'
                            : 'Add to this answer…'
                          : 'Comment to the Task Lead…'
              }
              value={answerText}
              disabled={sending}
              onChange={(event) =>
                questionChoices && other
                  ? setOtherText(event.target.value)
                  : setText(event.target.value)
              }
              onKeyDown={
                request.permission || request.simulator
                  ? undefined
                  : (event) =>
                      repairing
                        ? sendOnEnter(
                            () => event.currentTarget.form?.requestSubmit(),
                            () => !sending,
                          )(event)
                        : sendOnEnter(sendAnswer, () => !!ready && !sending)(event)
              }
            />
          )}
          {needsReason && (
            <p className={styles.caption}>A reason is required. Confirming closes this failure.</p>
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
                  disabled={sending || chosen === undefined}
                  onClick={() =>
                    send({
                      action: 'approve',
                      ...(chosen !== undefined && { simulator: chosen }),
                      ...withText,
                    })
                  }
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
                  pending={sending && submission?.action === 'approve'}
                  disabled={sending}
                  onClick={() => send({ action: 'approve', ...withText })}
                >
                  Approve
                </Button>
              </>
            ) : request.gate ? (
              <>
                <Button
                  data-request-changes
                  pending={sending && submission?.action === 'request-changes'}
                  disabled={sending || !typed}
                  onClick={() => send({ action: 'request-changes', text })}
                >
                  Request changes
                </Button>
                <Button
                  variant="primary"
                  arm="approve"
                  pending={sending && submission?.action === 'approve'}
                  disabled={sending}
                  onClick={() => send({ action: 'approve', ...withText })}
                >
                  {request.gate.approveLabel}
                </Button>
              </>
            ) : !repairing ? (
              <>
                {request.failed && (
                  <Help>
                    Choose Retry to start a fresh Task Lead Run from the brief, or Other answer to
                    leave a Comment for the next Run. Send confirms your choice.
                  </Help>
                )}
                <Button
                  variant="primary"
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
      )}
    </section>
  )
}

function answerLine(
  request: Comment,
  newer: Comment | undefined,
  task: Task,
): { mark: string; tone: string; text: string } | undefined {
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
            ? `You shut down ${answer.shutDown}’s simulator`
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
        return { mark: '–', tone: 'neutral', text: 'A simulator freed up; nothing was shut down' }
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
      if ('ciReported' in answer) {
        return { mark: '–', tone: 'neutral', text: 'Withdrawn · CI reported before you answered' }
      }
      if ('archived' in answer) {
        return {
          mark: '–',
          tone: 'neutral',
          text: 'Withdrawn · the Task was archived before you answered',
        }
      }
      return {
        mark: '–',
        tone: 'neutral',
        text: `Withdrawn · the Task went ${
          request.stage !== undefined && isBefore(answer.movedTo, request.stage) ? 'back' : 'on'
        } to ${stageName(answer.movedTo)} before you answered`,
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

const stageOrder: readonly string[] = [
  'backlog',
  'intake',
  'clarify',
  'design',
  'work',
  'validate',
  'review',
  'merge',
  'done',
]

function isBefore(a: string, b: string): boolean {
  return stageOrder.indexOf(a) < stageOrder.indexOf(b)
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
            Open Conversation
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
  const line = answerLine(request, newer, task)
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
          <h2 className={styles.title}>{headline(request)}</h2>
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
        <p className={styles.answeredTitle}>{headline(request)}</p>
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
          <span className={styles.answerText}>{line.text}</span>
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
