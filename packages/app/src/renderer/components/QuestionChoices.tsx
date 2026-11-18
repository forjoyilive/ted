import { type ReactNode, useId } from 'react'
import { ChoiceText } from './ChoiceText.tsx'
import styles from './QuestionChoices.module.css'

export type QuestionSelection = { choice: string } | { other: true } | SeveralSelection

export interface SeveralSelection {
  picks: string[]
  other?: boolean
}

export const isSeveral = (
  selection: QuestionSelection | undefined,
): selection is SeveralSelection => selection !== undefined && 'picks' in selection

export function QuestionChoices({
  choices,
  selection,
  onSelect,
  allowOther = true,
  multiple = false,
  legend = 'Your answer',
  otherLabel = 'Other answer',
  disabled,
  tagOf,
}: {
  choices: readonly string[]
  selection: QuestionSelection | undefined
  onSelect(selection: QuestionSelection): void
  allowOther?: boolean
  multiple?: boolean
  legend?: string
  otherLabel?: string
  disabled: boolean
  tagOf?: ((choice: string) => ReactNode) | undefined
}) {
  const group = useId()
  const several = multiple ? (isSeveral(selection) ? selection : { picks: [] }) : undefined
  const isSelected = (choice: string) =>
    several
      ? several.picks.includes(choice)
      : selection !== undefined && 'choice' in selection && selection.choice === choice
  const other = several ? several.other === true : selection !== undefined && 'other' in selection
  const pick = (choice: string) =>
    onSelect(
      several
        ? {
            ...several,
            picks: several.picks.includes(choice)
              ? several.picks.filter((c) => c !== choice)
              : [...several.picks, choice],
          }
        : { choice },
    )
  return (
    <fieldset className={styles.choices} disabled={disabled}>
      <legend className={styles.choiceLegend}>{several ? 'Pick any that apply' : legend}</legend>
      {choices.map((choice) => (
        <label
          key={choice}
          className={isSelected(choice) ? `${styles.choice} ${styles.selected}` : styles.choice}
        >
          <input
            type={several ? 'checkbox' : 'radio'}
            className={styles.radio}
            name={group}
            checked={isSelected(choice)}
            onChange={() => pick(choice)}
          />
          <ChoiceText choice={choice} className={styles.text} tag={tagOf?.(choice)} />
        </label>
      ))}
      {allowOther && (
        <label className={other ? `${styles.choice} ${styles.selected}` : styles.choice}>
          <input
            type={several ? 'checkbox' : 'radio'}
            className={styles.radio}
            name={group}
            checked={other}
            onChange={() => onSelect(several ? { ...several, other: !other } : { other: true })}
          />
          <span className={styles.text}>{otherLabel}</span>
        </label>
      )}
    </fieldset>
  )
}
