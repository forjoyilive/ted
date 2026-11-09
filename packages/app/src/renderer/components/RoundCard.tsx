import type { AnswerRequest, Comment, Round, RoundAnswer, RoundQuestion } from '@ted/protocol'
import { useId, useState } from 'react'
import { Button } from './Button.tsx'
import styles from './RoundCard.module.css'

interface Draft {
  answer: string
  note: string
}

const recommendedDrafts = (round: Round): Draft[] =>
  round.questions.map((q) => ({ answer: q.recommended, note: '' }))

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
  const changed = draft.answer.trim() !== question.recommended.trim()
  const reset = () => onChange({ ...draft, answer: question.recommended })
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
                const selected = draft.answer === choice
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
                      onChange={() => onChange({ ...draft, answer: choice })}
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
            </div>
            <input
              type="text"
              className={styles.note}
              aria-label={`Add to answer ${number}`}
              placeholder="Add to this answer…"
              value={draft.note}
              onChange={(event) => onChange({ ...draft, note: event.target.value })}
            />
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
  readOnly,
  sending,
  onSend,
  talk = true,
}: {
  round: Round
  readOnly: boolean
  sending: boolean
  onSend: (answer: AnswerRequest) => void
  talk?: boolean
}) {
  const [drafts, setDrafts] = useState(() => recommendedDrafts(round))
  const update = (i: number, draft: Draft) =>
    setDrafts((all) => all.map((d, at) => (at === i ? draft : d)))
  const complete = drafts.every((d) => d.answer.trim() !== '')
  return (
    <>
      <div className={styles.questions}>
        {round.questions.map((question, i) => (
          <Question
            key={question.question}
            question={question}
            number={i + 1}
            draft={drafts[i] ?? { answer: question.recommended, note: '' }}
            disabled={readOnly || sending}
            onChange={(draft) => update(i, draft)}
          />
        ))}
      </div>
      {!readOnly && (
        <div className={styles.buttons}>
          {talk && <Button disabled>Talk it through</Button>}
          <span className={styles.spacer} />
          <Button
            arm="accept-recommended"
            disabled={sending}
            onClick={() => {
              setDrafts(recommendedDrafts(round))
              onSend({ action: 'accept-recommended' })
            }}
          >
            Accept all recommended
          </Button>
          <Button
            variant="primary"
            disabled={sending || !complete}
            onClick={() =>
              onSend({
                action: 'answer-round',
                answers: drafts.map((d) => ({
                  answer: d.answer,
                  ...(d.note.trim() !== '' && { note: d.note }),
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
