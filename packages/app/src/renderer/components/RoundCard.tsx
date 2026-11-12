import type { AnswerRequest, Comment, Round, RoundAnswer, RoundQuestion } from '@ted/protocol'
import { useEffect, useId, useState } from 'react'
import { Button } from './Button.tsx'
import styles from './RoundCard.module.css'

interface Draft {
  answer: string
  note: string
  other?: boolean
  custom?: string
}

const initialDraft = (question: RoundQuestion): Draft => ({
  answer: question.choices ? '' : question.recommended,
  note: '',
})

function savedDrafts(key: string | undefined, count: number): Draft[] | undefined {
  try {
    const saved = key && sessionStorage.getItem(key)
    if (saved) {
      const parsed: unknown = JSON.parse(saved)
      if (
        Array.isArray(parsed) &&
        parsed.length === count &&
        parsed.every((d) => typeof d?.answer === 'string' && typeof d?.note === 'string')
      )
        return parsed
    }
  } catch {}
  return undefined
}

function Tag({ changed, onReset }: { changed: boolean; onReset: () => void }) {
  if (!changed) return <span className={styles.tag}>Recommended</span>
  return (
    <span className={`${styles.tag} ${styles.changed}`}>
      Changed ·{' '}
      <button type="button" className={styles.reset} onClick={onReset}>
        Reset
      </button>
    </span>
  )
}

function Question({
  question,
  number,
  draft,
  disabled,
  onChange,
}: {
  question: RoundQuestion
  number: number
  draft: Draft
  disabled: boolean
  onChange: (draft: Draft) => void
}) {
  const name = useId()
  const changed = draft.other || draft.answer.trim() !== question.recommended.trim()
  const reset = () => onChange({ ...draft, answer: question.recommended, other: false })
  return (
    <div className={styles.question}>
      <fieldset className={styles.fieldset} disabled={disabled}>
        <legend className={styles.prompt}>
          <span className={styles.number}>{number}.</span>
          {question.question}
        </legend>
        {question.choices ? (
          <>
            <div className={styles.options}>
              {question.choices.map((choice) => {
                const selected = !draft.other && draft.answer === choice
                const tagged = selected ? changed || choice === question.recommended : false
                return (
                  <label
                    key={choice}
                    className={selected ? `${styles.option} ${styles.selected}` : styles.option}
                  >
                    <input
                      type="radio"
                      className={styles.radio}
                      name={name}
                      checked={selected}
                      onChange={() => onChange({ ...draft, answer: choice, other: false })}
                    />
                    <span className={styles.optionText}>{choice}</span>
                    {tagged ? (
                      <Tag changed={changed} onReset={reset} />
                    ) : (
                      choice === question.recommended && (
                        <span className={styles.tag}>Recommended</span>
                      )
                    )}
                  </label>
                )
              })}
              <label
                className={draft.other ? `${styles.option} ${styles.selected}` : styles.option}
              >
                <input
                  type="radio"
                  className={styles.radio}
                  name={name}
                  checked={draft.other ?? false}
                  onChange={() => onChange({ ...draft, other: true })}
                />
                <span className={styles.optionText}>Other</span>
                {draft.other && <Tag changed onReset={reset} />}
              </label>
            </div>
            {draft.other ? (
              <div className={styles.written}>
                <textarea
                  className={styles.text}
                  aria-label={`Your answer ${number}`}
                  placeholder="Your answer…"
                  value={draft.custom ?? ''}
                  onChange={(event) => onChange({ ...draft, custom: event.target.value })}
                />
              </div>
            ) : (
              <input
                type="text"
                className={styles.note}
                aria-label={`Add to answer ${number}`}
                placeholder="Add to this answer…"
                value={draft.note}
                onChange={(event) => onChange({ ...draft, note: event.target.value })}
              />
            )}
          </>
        ) : (
          <div className={changed ? `${styles.written} ${styles.writtenChanged}` : styles.written}>
            <textarea
              className={styles.text}
              aria-label={`Answer ${number}`}
              value={draft.answer}
              onChange={(event) => onChange({ ...draft, answer: event.target.value })}
            />
            <div className={styles.writtenTag}>
              <Tag changed={changed} onReset={reset} />
            </div>
          </div>
        )}
      </fieldset>
    </div>
  )
}

export function RoundQuestions({
  round,
  draftKey,
  waiting = false,
  readOnly,
  sending,
  talking,
  onSend,
  onTalk,
}: {
  round: Round
  draftKey?: string
  waiting?: boolean
  readOnly: boolean
  sending: boolean
  talking: boolean
  onSend: (answer: AnswerRequest) => void
  onTalk: (() => void) | undefined
}) {
  const storageKey = draftKey ? `ted.round-draft.${draftKey}` : undefined
  const [drafts, setDrafts] = useState<Draft[]>(
    () => savedDrafts(storageKey, round.questions.length) ?? round.questions.map(initialDraft),
  )
  useEffect(() => {
    if (!storageKey) return
    const changed = (event: Event) => {
      if (event instanceof CustomEvent && event.detail?.key === storageKey)
        setDrafts(event.detail.drafts)
    }
    const saved = savedDrafts(storageKey, round.questions.length)
    if (saved) setDrafts(saved)
    window.addEventListener('ted-round-drafts-changed', changed)
    return () => window.removeEventListener('ted-round-drafts-changed', changed)
  }, [storageKey, round.questions.length])
  const update = (i: number, draft: Draft) => {
    const next = drafts.map((d, at) => (at === i ? draft : d))
    setDrafts(next)
    try {
      if (storageKey) {
        sessionStorage.setItem(storageKey, JSON.stringify(next))
      }
    } catch {}
    if (storageKey)
      window.dispatchEvent(
        new CustomEvent('ted-round-drafts-changed', { detail: { key: storageKey, drafts: next } }),
      )
  }
  const complete = drafts.every((d) => (d.other ? (d.custom ?? '') : d.answer).trim() !== '')
  return (
    <>
      <div className={styles.questions}>
        {round.questions.map((question, i) => (
          <Question
            key={question.question}
            question={question}
            number={i + 1}
            draft={drafts[i] ?? initialDraft(question)}
            disabled={readOnly || sending}
            onChange={(draft) => update(i, draft)}
          />
        ))}
      </div>
      {!readOnly && (
        <div className={styles.buttons}>
          {onTalk && (
            <Button className={styles.talk} disabled={sending || waiting} onClick={onTalk}>
              {waiting ? 'Waiting for Task Lead…' : talking ? 'Open chat' : 'Talk it through'}
            </Button>
          )}
          <Button
            variant="primary"
            disabled={sending || !complete}
            onClick={() =>
              onSend({
                action: 'answer-round',
                answers: drafts.map((d) => ({
                  answer: d.other ? (d.custom ?? '') : d.answer,
                  ...(!d.other && d.note.trim() !== '' && { note: d.note }),
                })),
              })
            }
          >
            Submit answers
          </Button>
        </div>
      )}
    </>
  )
}

export function roundTally(answers: readonly RoundAnswer[]): string {
  const changed = answers.filter((a) => a.changed).length
  const recommended = answers.length - changed
  return [
    ...(recommended > 0 ? [`${recommended} recommended`] : []),
    ...(changed > 0 ? [`${changed} changed`] : []),
  ].join(', ')
}

export function RoundAnswers({
  request,
  answers,
}: {
  request: Pick<Comment, 'round'>
  answers: readonly RoundAnswer[]
}) {
  const questions = request.round?.questions ?? []
  return (
    <ol className={styles.answers}>
      {answers.map((answer, i) => (
        <li key={questions[i]?.question ?? i} className={styles.answerRow}>
          <span className={styles.answerNumber}>{i + 1}.</span>
          <span className={styles.answerText}>
            {answer.answer}
            {answer.note !== undefined && (
              <span className={styles.answerNote}>{` · ${answer.note}`}</span>
            )}
          </span>
          <span className={answer.changed ? styles.answerChanged : styles.answerRecommended}>
            {answer.changed ? 'changed' : 'recommended'}
          </span>
        </li>
      ))}
    </ol>
  )
}
