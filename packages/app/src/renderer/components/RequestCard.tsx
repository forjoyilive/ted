import type { AnswerRequest, Comment, Task } from '@ted/protocol'
import { useState } from 'react'
import { ago, briefSections, headline, kindLabels, poster, summary, useNow } from '../requests.ts'
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

export function RequestCard({ request, task }: { request: Comment; task: Task }) {
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
    <section className={styles.card} aria-label={kindLabels[request.kind]}>
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
              disabled={sending}
              onClick={() => void send({ action: 'answer', choice, ...withText })}
            >
              {choice}
            </button>
          ))}
        </div>
      )}
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
          void send(request.gate ? { action: 'request-changes', text } : { action: 'answer', text })
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
    </section>
  )
}

function answerLine(request: Comment): { mark: string; tone: string; text: string } | undefined {
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
      return {
        mark: '–',
        tone: 'neutral',
        text: `Withdrawn · the Task went ${
          request.stage !== undefined && isBefore(answer.movedTo, request.stage) ? 'back' : 'on'
        } to ${stageName(answer.movedTo)} before you answered`,
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

export function AnsweredCard({ request, task }: { request: Comment; task: Task }) {
  const now = useNow()
  const line = answerLine(request)
  const quoted = request.answer && 'text' in request.answer ? request.answer.text : undefined
  return (
    <section className={styles.answered} aria-label={`${kindLabels[request.kind]}, answered`}>
      <CardHead request={request} task={task} now={now} />
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
    </section>
  )
}

export function OpenRequestLine({ request, onPin }: { request: Comment; onPin: () => void }) {
  return (
    <button type="button" className={styles.openLine} onClick={onPin}>
      <span className={styles.kind}>{kindLabels[request.kind]}</span>
      <span className={styles.openTitle}>{headline(request)}</span>
      <span className={styles.openHint}>Waiting on you</span>
    </button>
  )
}
