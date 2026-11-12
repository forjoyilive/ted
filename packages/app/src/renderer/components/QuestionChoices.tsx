import { useId } from 'react'
import styles from './QuestionChoices.module.css'

export type QuestionSelection = { choice: string } | { other: true }

export function QuestionChoices({
  choices,
  selection,
  onSelect,
  allowOther = true,
  legend = 'Your answer',
  otherLabel = 'Other answer',
  disabled,
}: {
  choices: readonly string[]
  selection: QuestionSelection | undefined
  onSelect(selection: QuestionSelection): void
  allowOther?: boolean
  legend?: string
  otherLabel?: string
  disabled: boolean
}) {
  const group = useId()
  const selectedChoice = selection && 'choice' in selection ? selection.choice : undefined
  const other = selection && 'other' in selection
  return (
    <fieldset className={styles.choices} disabled={disabled}>
      <legend className={styles.choiceLegend}>{legend}</legend>
      {choices.map((choice) => (
        <label
          key={choice}
          className={
            selectedChoice === choice ? `${styles.choice} ${styles.selected}` : styles.choice
          }
        >
          <input
            type="radio"
            className={styles.radio}
            name={group}
            checked={selectedChoice === choice}
            onChange={() => onSelect({ choice })}
          />
          <span>{choice}</span>
        </label>
      ))}
      {allowOther && (
        <label className={other ? `${styles.choice} ${styles.selected}` : styles.choice}>
          <input
            type="radio"
            className={styles.radio}
            name={group}
            checked={other ?? false}
            onChange={() => onSelect({ other: true })}
          />
          <span>{otherLabel}</span>
        </label>
      )}
    </fieldset>
  )
}
