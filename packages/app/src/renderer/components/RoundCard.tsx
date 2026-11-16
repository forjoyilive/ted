import type {
  AnswerRequest,
  Comment,
  MessageBox,
  Round,
  RoundAnswer,
  RoundQuestion,
} from '@ted/protocol'
import { type KeyboardEvent, useId } from 'react'
import { enterAction } from '../composer-keys.ts'
import { draftField, useMessageDraft } from '../message-drafts.ts'
import { Button } from './Button.tsx'
import { ChoiceText } from './ChoiceText.tsx'
import styles from './RoundCard.module.css'
import grow from './TextGrow.module.css'

interface Draft {
  answer: string
  note: string
  other?: boolean
  custom?: string
  picks?: string[]
}

const recommendedPicks = (question: RoundQuestion): string[] => question.recommendedChoices ?? []

const initialDraft = (question: RoundQuestion): Draft => ({
  answer: question.choices ? '' : question.recommended,
  note: '',
  ...(question.multiple && { picks: [] }),
})

const isDraft = (value: unknown): value is Draft => {
  if (value === null || typeof value !== 'object') return false
  const { answer, note, other, custom, picks } = value as Record<string, unknown>
  return (
    typeof answer === 'string' &&
    typeof note === 'string' &&
    (other === undefined || typeof other === 'boolean') &&
    (custom === undefined || typeof custom === 'string') &&
    (picks === undefined || (Array.isArray(picks) && picks.every((p) => typeof p === 'string')))
  )
}

const picked = (question: RoundQuestion, draft: Draft): string[] =>
  (question.choices ?? []).filter((c) => draft.picks?.includes(c))

const isChanged = (question: RoundQuestion, draft: Draft): boolean =>
  draft.answer.trim() !== question.recommended.trim()

const isAnswered = (question: RoundQuestion, draft: Draft): boolean => {
  const written = draft.other === true && writtenText(draft).trim() !== ''
  if (question.multiple) return picked(question, draft).length > 0 || written
  return draft.other ? written : draft.answer.trim() !== ''
}

export const writtenText = (draft: Pick<Draft, 'note' | 'other' | 'custom'>): string => {
  const custom = draft.custom ?? ''
  if (draft.other) return custom !== '' ? custom : draft.note
  return draft.note !== '' ? draft.note : custom
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
  const changed = isChanged(question, draft)
  const text = writtenText(draft)
  const write = (value: string) => onChange({ ...draft, note: value, custom: value })
  const reset = () => onChange({ ...draft, answer: question.recommended })
  const several = question.multiple === true
  const ticked = picked(question, draft)
  const toggle = (choice: string) =>
    onChange({
      ...draft,
      picks: ticked.includes(choice) ? ticked.filter((c) => c !== choice) : [...ticked, choice],
    })
  return (
    <div className={styles.question}>
      <fieldset className={styles.fieldset} disabled={disabled}>
        <legend className={styles.prompt}>
          <span className={styles.number}>{number}.</span>
          <span className={styles.promptText}>{question.question}</span>
        </legend>
        {several && <p className={styles.hint}>Pick any that apply.</p>}
        {question.choices ? (
          <>
            <div className={styles.options}>
              {question.choices.map((choice) => {
                const recommended = several
                  ? recommendedPicks(question).includes(choice)
                  : choice === question.recommended
                const selected = several
                  ? ticked.includes(choice)
                  : !draft.other && draft.answer === choice
                return (
                  <label
                    key={choice}
                    className={selected ? `${styles.option} ${styles.selected}` : styles.option}
                  >
                    <input
                      type={several ? 'checkbox' : 'radio'}
                      className={styles.radio}
                      name={name}
                      checked={selected}
                      onChange={() =>
                        several
                          ? toggle(choice)
                          : onChange({ ...draft, answer: choice, other: false })
                      }
                    />
                    <ChoiceText choice={choice} className={styles.optionText} />
                    {recommended && <span className={styles.tag}>Recommended</span>}
                  </label>
                )
              })}
              <label
                className={draft.other ? `${styles.option} ${styles.selected}` : styles.option}
              >
                <input
                  type={several ? 'checkbox' : 'radio'}
                  className={styles.radio}
                  name={name}
                  checked={draft.other ?? false}
                  onChange={() => onChange({ ...draft, other: several ? !draft.other : true })}
                />
                <span className={styles.optionText}>Other</span>
              </label>
            </div>
            {draft.other ? (
              <div className={styles.written}>
                <textarea
                  className={`${styles.text} ${styles.otherText} ${grow.text}`}
                  aria-label={`Your answer ${number}`}
                  placeholder="Your answer…"
                  value={text}
                  onChange={(event) => write(event.target.value)}
                />
              </div>
            ) : (
              <input
                type="text"
                className={styles.note}
                aria-label={`Add to answer ${number}`}
                data-arrows
                placeholder="Add to this answer…"
                value={text}
                onChange={(event) => write(event.target.value)}
              />
            )}
          </>
        ) : (
          <div className={changed ? `${styles.written} ${styles.writtenChanged}` : styles.written}>
            <textarea
              className={`${styles.text} ${grow.text}`}
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
  waiting = false,
  readOnly,
  sending,
  talking,
  onSend,
  onTalk,
  box,
}: {
  round: Round
  box?: MessageBox | undefined
  waiting?: boolean
  readOnly: boolean
  sending: boolean
  talking: boolean
  onSend: (answer: AnswerRequest) => void
  onTalk: (() => void) | undefined
}) {
  const kept = useMessageDraft(box)
  const [drafts, setDrafts] = draftField(
    kept,
    'answers',
    round.questions.map(initialDraft),
    (value): value is Draft[] =>
      Array.isArray(value) && value.length === round.questions.length && value.every(isDraft),
  )
  const update = (i: number, draft: Draft) =>
    setDrafts(drafts.map((d, at) => (at === i ? draft : d)))
  const complete = round.questions.every((q, i) => isAnswered(q, drafts[i] ?? initialDraft(q)))
  const submit = () =>
    onSend({
      action: 'answer-round',
      answers: round.questions.map((q, i) => {
        const d = drafts[i] ?? initialDraft(q)
        const text = writtenText(d)
        return {
          answer: d.other ? text : q.multiple ? '' : d.answer,
          ...(q.multiple && { choices: picked(q, d) }),
          ...(!d.other && text.trim() !== '' && { note: text }),
        }
      }),
    })
  const submitOnCommandEnter = (event: KeyboardEvent<HTMLDivElement>) => {
    const action = enterAction({
      key: event.key,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      isComposing: event.nativeEvent.isComposing,
      keyCode: event.nativeEvent.keyCode,
    })
    if (action !== 'command-send') return
    event.preventDefault()
    if (complete && !sending) submit()
  }
  return (
    <div className={styles.round} {...(!readOnly && { onKeyDown: submitOnCommandEnter })}>
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
          <Button variant="primary" shortcut="⌘↵" disabled={sending || !complete} onClick={submit}>
            Submit answers
          </Button>
        </div>
      )}
    </div>
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
