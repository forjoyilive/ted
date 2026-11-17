import type { ReactNode } from 'react'
import styles from './ChoiceText.module.css'

export function choiceParts(choice: string): { label: string; detail?: string } {
  const at = choice.indexOf('\n')
  if (at === -1) return { label: choice }
  const detail = choice.slice(at + 1)
  return { label: choice.slice(0, at), ...(detail.trim() !== '' && { detail }) }
}

export function ChoiceText({
  choice,
  className,
  tag,
}: {
  choice: string
  className?: string | undefined
  tag?: ReactNode
}) {
  const { label, detail } = choiceParts(choice)
  const mark = tag ? (
    <>
      <span className={styles.space}> </span>
      {tag}
    </>
  ) : null
  if (detail === undefined)
    return (
      <span className={className}>
        {label}
        {mark}
      </span>
    )
  return (
    <span className={className ? `${styles.choice} ${className}` : styles.choice}>
      <span className={styles.label}>
        {label}
        {mark}
      </span>
      <span className={styles.detail}>{detail}</span>
    </span>
  )
}
