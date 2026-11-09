import type { AnswerRequest, Comment, CommentAnswer, Task } from '@ted/protocol'
import { useState } from 'react'
import {
  age,
  ago,
  briefSections,
  headline,
  kindLabels,
  poster,
  summary,
  useNow,
} from '../requests.ts'
import { ted } from '../ted.ts'
import { stageName } from '../views/TaskViews.tsx'
import { Button } from './Button.tsx'
import styles from './RequestCard.module.css'

function CardHead({ request, task, now }: { request: Comment; task: Task; now: number }) {
  return (
    <div className={styles.head}>
      <span className={styles.kind}>{kindLabels[request.kind]}</span>
      <span>{` · from ${poster(request, task)} · ${ago(request.createdAt, now)}`}</span>
    </div>
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

export function RequestCard({
  request,
  task,
  readOnly = false,
}: {
  request: Comment
  task: Task
  readOnly?: boolean
}) {
  const now = useNow()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const shown = summary(request)
  const typed = text.trim() !== ''

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

  return (
    <section
      className={readOnly ? `${styles.card} ${styles.readOnly}` : styles.card}
      aria-label={readOnly ? `${kindLabels[request.kind]}, read-only` : kindLabels[request.kind]}
    >
      <CardHead request={request} task={task} now={now} />
      <h2 className={styles.title}>{headline(request)}</h2>
      {request.gate ? (
        <BriefSections text={request.body} title={headline(request)} />
      ) : (
        shown !== undefined && <p className={styles.summary}>{shown}</p>
      )}
      {request.choices && request.choices.length > 0 && (
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
      {!readOnly && (
        <>
          <textarea
            className={styles.box}
            aria-label="Your answer"
            placeholder={
              request.kind === 'question' && request.choices
                ? 'Or write your own answer…'
                : 'Comment to the Task Lead…'
            }
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || !typed) return
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
            {request.gate?.caption !== undefined && (
              <span className={styles.caption}>{request.gate.caption}</span>
            )}
            {request.gate ? (
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
      return { mark: '✓', tone: 'good', text: 'You approved' }
    case 'changes-requested':
      return { mark: '↩', tone: 'neutral', text: 'You requested changes' }
    case 'answered':
      return answer.choice !== undefined
        ? { mark: '✓', tone: 'good', text: `You answered: ${answer.choice}` }
        : { mark: '✓', tone: 'good', text: 'You answered in your own words' }
    case 'withdrawn':
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
}: {
  request: Comment
  task: Task
  newer?: Comment | undefined
}) {
  const now = useNow()
  const [showing, setShowing] = useState(false)
  const line = answerLine(request, newer, task)
  const quoted = request.answer && 'text' in request.answer ? request.answer.text : undefined
  const outcome = (request.answer && outcomes[request.answer.kind]) ?? 'answered'
  return (
    <section className={styles.answered} aria-label={`${kindLabels[request.kind]}, ${outcome}`}>
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
      <p className={styles.answeredTitle}>{headline(request)}</p>
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
        {`${kindLabels[request.kind]} from ${poster(request, task)} · waiting · ${
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
            {`${kindLabels[request.kind]} · ${age(request.createdAt, now)}`}
          </button>
        ))}
      </div>
    </fieldset>
  )
}
