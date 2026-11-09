import type {
  AnswerRequest,
  Comment,
  CommentAnswer,
  MergeRow,
  SignOffChanges,
  Task,
} from '@ted/protocol'
import { useEffect, useRef, useState } from 'react'
import { useCheckRuns, useComments, useThreadEvents } from '../data.ts'
import {
  age,
  ago,
  briefSections,
  headline,
  kindLabels,
  poster,
  requestLabel,
  summary,
  useNow,
} from '../requests.ts'
import { ted } from '../ted.ts'
import { stageName } from '../views/TaskViews.tsx'
import { Button } from './Button.tsx'
import { CheckOutputDialog } from './CheckOutputDialog.tsx'
import { ChecksRow } from './ChecksRow.tsx'
import { Help } from './Help.tsx'
import styles from './RequestCard.module.css'
import { RoundAnswers, RoundQuestions, roundTally } from './RoundCard.tsx'

function CardHead({ request, task, now }: { request: Comment; task: Task; now: number }) {
  const again = request.gate?.changes !== undefined && request.stage !== 'merge'
  return (
    <div className={styles.head}>
      <span className={request.failed ? `${styles.kind} ${styles.failedKind}` : styles.kind}>
        {requestLabel(request)}
      </span>
      <span>
        {`${request.round ? ` · Round ${request.round.number}` : ''}${again ? ' · again' : ''}${request.gate?.pullRequests ? ' · Merge' : ''} · from ${poster(request, task)} · ${ago(request.createdAt, now)}`}
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
                <button
                  type="button"
                  className={styles.mergeLink}
                  onClick={() => void ted.openPullRequest(taskId, row.name)}
                >
                  {`PR #${row.number} · ${row.title}`}
                </button>
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

function ChangesBlock({ changes }: { changes: SignOffChanges }) {
  return (
    <section className={styles.changes} aria-label="Changes since you approved">
      <h3 className={styles.sectionHeading}>Changes since you approved</h3>
      {changes.summary !== undefined && <p className={styles.sectionBody}>{changes.summary}</p>}
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

function FirstSignOff({ id, task }: { id: string; task: Task }) {
  const first = useComments(task.id).find((c) => c.id === id)
  if (!first) return null
  return <RequestCard request={first} task={task} readOnly />
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
    <div className={styles.content}>
      {sections.map(({ heading, body }) => (
        <section key={heading} className={styles.section} aria-label={heading}>
          <h3 className={styles.sectionHeading}>{heading}</h3>
          <p className={styles.sectionBody}>{body}</p>
        </section>
      ))}
    </div>
  )
}

function ConfirmationRow({ request, task }: { request: Comment; task: Task }) {
  const events = useThreadEvents(task.id)
  const checkRuns = useCheckRuns(task.id)
  const [open, setOpen] = useState<number>()
  const validated = events.findLast((e) => e.validate === 'passed' && e.at <= request.createdAt)
  if (!validated) return null
  const checkRun = checkRuns.find((r) => r.id === validated.checkRunId)
  if (!checkRun && !validated.judgments) return null
  return (
    <div className={styles.confirmation}>
      <ChecksRow
        checks={checkRun?.checks ?? []}
        {...(validated.judgments && { judgments: validated.judgments })}
        onOpen={setOpen}
      />
      {checkRun && open !== undefined && (
        <CheckOutputDialog checkRun={checkRun} position={open} onClose={() => setOpen(undefined)} />
      )}
    </div>
  )
}

function SignoffDecisions({ text }: { text: string }) {
  const sections = briefSections(text)
  const body = (name: string) =>
    sections.find((s) => s.heading.toLowerCase() === name)?.body.trim() ?? ''
  const decisions = body('decisions so far')
  const open = body('open questions')
  const items = decisions
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter((line) => line !== '')
  return (
    <>
      <section className={styles.content} aria-label="Decisions so far">
        <h3 className={styles.sectionHeading}>Decisions so far</h3>
        {items.length === 0 ? (
          <p className={styles.sectionBody}>None yet.</p>
        ) : (
          <ul className={styles.decisions}>
            {items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
      </section>
      <p className={styles.openQuestions}>
        {`Open questions: ${open === '' ? 'none.' : open.replace(/\s*\n\s*/g, ' ')}`}
      </p>
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

function Summary({ text }: { text: string }) {
  let at = 0
  const paragraphs = text.split(/\n\s*\n/).map((paragraph) => {
    at += paragraph.length + 1
    return { paragraph, key: at }
  })
  return (
    <div className={styles.summaryBlock}>
      {paragraphs.map(({ paragraph, key }) =>
        paragraph.startsWith('```') ? (
          <pre key={key} className={styles.command}>
            {paragraph.replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, '')}
          </pre>
        ) : paragraph.startsWith('> ') ? (
          <blockquote key={key} className={styles.quoted}>
            “{paragraph.slice(2).trim()}”
          </blockquote>
        ) : (
          <p key={key} className={styles.summary}>
            {paragraph}
          </p>
        ),
      )}
    </div>
  )
}

export function RequestCard({
  request,
  task,
  readOnly = false,
  onOpenRun,
}: {
  request: Comment
  task: Task
  readOnly?: boolean
  onOpenRun?: ((runId: string) => void) | undefined
}) {
  const now = useNow()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const shown = summary(request)
  const typed = text.trim() !== ''
  const [showingFirst, setShowingFirst] = useState(false)
  const changes = request.gate?.changes
  const rows = request.gate?.pullRequests
  const short =
    changes !== undefined && rows === undefined && !changes.repos.some((r) => r.unavailable)

  async function send(answer: AnswerRequest) {
    setSending(true)
    setError(undefined)
    try {
      await ted.answerRequest(request.id, answer)
      setText('')
    } catch (failed) {
      setError(failed instanceof Error ? failed.message : String(failed))
    } finally {
      setSending(false)
    }
  }

  const withText = typed ? { text } : {}
  const actionChoice =
    request.author.kind === 'ted' && request.choices?.length === 1 ? request.choices[0] : undefined

  return (
    <section
      className={[
        styles.card,
        ...(request.failed ? [styles.failedCard] : []),
        ...(readOnly ? [styles.readOnly] : []),
      ].join(' ')}
      aria-label={readOnly ? `${requestLabel(request)}, read-only` : requestLabel(request)}
    >
      <div className={styles.headRow}>
        <CardHead request={request} task={task} now={now} />
        {changes && !rows && !readOnly && (
          <button
            type="button"
            className={styles.showRequest}
            aria-expanded={showingFirst}
            onClick={() => setShowingFirst(!showingFirst)}
          >
            {showingFirst ? 'Hide first sign-off' : 'Show first sign-off'}
          </button>
        )}
      </div>
      {showingFirst && changes && !rows && <FirstSignOff id={changes.since} task={task} />}
      <h2 className={styles.title}>{headline(request)}</h2>
      {rows && <MergeRows rows={rows} taskId={task.id} />}
      {rows && changes && <MergeChangesLine changes={changes} />}
      {changes && !rows && <ChangesBlock changes={changes} />}
      {request.kind === 'signoff' && request.stage === 'review' && (
        <ConfirmationRow request={request} task={task} />
      )}
      {request.gate && request.stage === 'clarify' ? (
        <SignoffDecisions text={request.body} />
      ) : request.gate ? (
        !short &&
        request.body.trim() !== '' && (
          <BriefSections text={request.body} title={headline(request)} />
        )
      ) : (
        shown !== undefined && shown !== '' && <Summary text={shown} />
      )}
      {request.round && (
        <RoundQuestions
          round={request.round}
          readOnly={readOnly}
          sending={sending}
          onSend={(answer) => void send(answer)}
        />
      )}
      {request.round && error !== undefined && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <PermissionCommand request={request} />
      {actionChoice === undefined && request.choices && request.choices.length > 0 && (
        <div className={styles.choices}>
          {request.choices.map((choice) => (
            <button
              key={choice}
              type="button"
              className={styles.choice}
              disabled={sending || readOnly}
              onClick={() => void send({ action: 'answer', choice, ...withText })}
            >
              {choice}
            </button>
          ))}
        </div>
      )}
      {!readOnly && !request.round && (
        <>
          <textarea
            className={styles.box}
            aria-label="Your answer"
            placeholder={
              request.permission
                ? 'Comment, or say why you’re denying…'
                : request.failed
                  ? 'Or tell the Task Lead what to change, then Retry…'
                  : actionChoice !== undefined
                    ? 'Comment, or tell the Task Lead what to do next…'
                    : request.kind === 'question' && request.choices
                      ? 'Or write your own answer…'
                      : 'Comment to the Task Lead…'
            }
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || !typed) return
              if (request.permission) return
              event.preventDefault()
              void send(
                request.gate ? { action: 'request-changes', text } : { action: 'answer', text },
              )
            }}
          />
          {error !== undefined && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.buttons}>
            {request.failed && onOpenRun && (
              <button
                type="button"
                className={styles.openRun}
                onClick={() => onOpenRun(request.failed?.runId ?? '')}
              >
                Open last Run
              </button>
            )}
            {request.gate?.caption !== undefined &&
              (request.stage === 'clarify' ? (
                <span className={styles.caption}>{request.gate.caption}</span>
              ) : (
                <Help>{request.gate.caption}</Help>
              ))}
            {request.permission ? (
              <>
                <Help>Applies to this request only.</Help>
                <Button
                  disabled={sending}
                  onClick={() => void send({ action: 'deny', ...withText })}
                >
                  Deny
                </Button>
                <Button
                  variant="primary"
                  disabled={sending}
                  onClick={() => void send({ action: 'approve', ...withText })}
                >
                  Approve
                </Button>
              </>
            ) : request.gate ? (
              <>
                <Button
                  disabled={sending || !typed}
                  onClick={() => void send({ action: 'request-changes', text })}
                >
                  Request changes
                </Button>
                <Button
                  variant="primary"
                  disabled={sending}
                  onClick={() => void send({ action: 'approve', ...withText })}
                >
                  {request.gate.approveLabel}
                </Button>
              </>
            ) : actionChoice !== undefined ? (
              <>
                {request.failed && (
                  <Help>
                    Send keeps your Comment for the next Run. Retry sends it and starts a fresh Task
                    Lead Run from the brief.
                  </Help>
                )}
                <Button
                  disabled={sending || !typed}
                  onClick={() => void send({ action: 'answer', text })}
                >
                  Send
                </Button>
                <Button
                  variant="primary"
                  disabled={sending}
                  onClick={() =>
                    void send({
                      action: 'answer',
                      choice: actionChoice,
                      ...(request.failed ? withText : {}),
                    })
                  }
                >
                  {actionChoice}
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                disabled={sending || !typed}
                onClick={() => void send({ action: 'answer', text })}
              >
                Send
              </Button>
            )}
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
  switch (answer.kind) {
    case 'approved':
      return {
        mark: '✓',
        tone: 'good',
        text: request.permission ? 'You approved · this request only' : 'You approved',
      }
    case 'denied':
      return { mark: '✕', tone: 'bad', text: 'You denied' }
    case 'changes-requested':
      return { mark: '↩', tone: 'neutral', text: 'You requested changes' }
    case 'answered':
      if (answer.answers) {
        return { mark: '✓', tone: 'good', text: `You answered · ${roundTally(answer.answers)}` }
      }
      return answer.choice !== undefined
        ? { mark: '✓', tone: 'good', text: `You answered: ${answer.choice}` }
        : { mark: '✓', tone: 'good', text: 'You answered in your own words' }
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

export function AnsweredCard({
  request,
  task,
  newer,
  expanded = false,
}: {
  request: Comment
  task: Task
  newer?: Comment | undefined
  expanded?: boolean
}) {
  const now = useNow()
  const [showing, setShowing] = useState(expanded)
  const card = useRef<HTMLElement>(null)
  useEffect(() => {
    if (expanded) card.current?.scrollIntoView({ block: 'nearest' })
  }, [expanded])
  const line = answerLine(request, newer, task)
  const quoted = request.answer && 'text' in request.answer ? request.answer.text : undefined
  const outcome = (request.answer && outcomes[request.answer.kind]) ?? 'answered'
  return (
    <section
      ref={card}
      className={styles.answered}
      aria-label={`${requestLabel(request)}, ${outcome}`}
    >
      <div className={styles.answeredHead}>
        <CardHead request={request} task={task} now={now} />
        <button
          type="button"
          className={styles.showRequest}
          aria-expanded={showing}
          onClick={() => setShowing(!showing)}
        >
          {showing ? 'Hide request' : 'Show request'}
        </button>
      </div>
      {request.permission ? (
        <p className={styles.answeredCommand}>{request.permission.command}</p>
      ) : (
        <p className={styles.answeredTitle}>{headline(request)}</p>
      )}
      {request.answer?.kind === 'answered' && request.answer.answers && (
        <RoundAnswers request={request} answers={request.answer.answers} />
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
      {quoted !== undefined && quoted !== '' && <p className={styles.quote}>“{quoted}”</p>}
      {showing && <RequestCard request={request} task={task} readOnly />}
    </section>
  )
}

export function OpenRequestLine({
  request,
  task,
  pinned,
  others,
  onPin,
}: {
  request: Comment
  task: Task
  pinned: boolean
  others: number
  onPin: () => void
}) {
  const now = useNow()
  return (
    <button type="button" className={styles.openLine} onClick={onPin}>
      <span className={styles.openDot} aria-hidden />
      <span className={styles.openTitle}>
        {`${requestLabel(request)} from ${poster(request, task)} · waiting · ${
          pinned ? 'shown below' : `${others} more below`
        }`}
      </span>
      <span className={styles.openAge}>{ago(request.createdAt, now)}</span>
    </button>
  )
}

export function WaitingRow({
  requests,
  pinnedId,
  onPin,
}: {
  requests: readonly Comment[]
  pinnedId: string | undefined
  onPin: (id: string) => void
}) {
  const now = useNow()
  const label = `${requests.length} waiting on you`
  return (
    <fieldset className={styles.waitingRow} aria-label={label}>
      <span className={styles.waitingCount}>{label}</span>
      <div className={styles.chips}>
        {requests.map((request) => (
          <button
            key={request.id}
            type="button"
            className={styles.chip}
            aria-pressed={request.id === pinnedId}
            title={headline(request)}
            onClick={() => onPin(request.id)}
          >
            {`${requestLabel(request)} · ${age(request.createdAt, now)}`}
          </button>
        ))}
      </div>
    </fieldset>
  )
}
