import styles from './ChoiceText.module.css'

export function choiceParts(choice: string): { label: string; detail?: string } {
  const at = choice.indexOf('\n')
  if (at === -1) return { label: choice }
  const detail = choice.slice(at + 1).trim()
  return { label: choice.slice(0, at), ...(detail !== '' && { detail }) }
}

export function ChoiceText({
  choice,
  className,
}: {
  choice: string
  className?: string | undefined
}) {
  const { label, detail } = choiceParts(choice)
  if (detail === undefined) return <span className={className}>{label}</span>
  return (
    <span className={className ? `${styles.choice} ${className}` : styles.choice}>
      <span className={styles.label}>{label}</span>
      <span className={styles.detail}>{detail}</span>
    </span>
  )
}
