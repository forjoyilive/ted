import type { ReactNode } from 'react'
import { Button } from '../components/Button.tsx'
import styles from './Onboarding.module.css'

export function StepIndicator({ step, count }: { step: number; count: number }) {
  return (
    <span className={styles.steps}>
      <span className={styles.dots} aria-hidden>
        {Array.from({ length: count }, (_, index) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: the dots are positions, not items
            key={index}
            className={styles.dot}
            data-state={index === step ? 'current' : index < step ? 'done' : undefined}
          />
        ))}
      </span>
      {`Step ${step + 1} of ${count}`}
    </span>
  )
}

export function OnboardingFrame({
  label,
  centered = false,
  narrow = false,
  footer,
  children,
}: {
  label: string
  centered?: boolean
  narrow?: boolean
  footer?: ReactNode
  children?: ReactNode
}) {
  return (
    <main className={styles.screen} aria-label={label}>
      <div className={`${styles.scroll} ${centered ? styles.centered : ''}`}>
        <div className={`${styles.column} ${narrow ? styles.narrow : ''}`}>{children}</div>
      </div>
      {footer !== undefined && (
        <div className={styles.bar}>
          <div className={`${styles.column} ${styles.barRow}`}>{footer}</div>
        </div>
      )}
    </main>
  )
}

export function StepFooter({
  step,
  count,
  note,
  next = 'Next',
  nextDisabled = false,
  busy = false,
  onSkip,
  onBack,
  onNext,
}: {
  step: number
  count: number
  note?: ReactNode
  next?: string
  nextDisabled?: boolean
  busy?: boolean
  onSkip: () => void
  onBack: () => void
  onNext: () => void
}) {
  return (
    <>
      <StepIndicator step={step} count={count} />
      <span className={styles.spacer} />
      {note}
      <Button variant="quiet" disabled={busy} onClick={onSkip}>
        Skip
      </Button>
      <Button disabled={busy || step === 0} onClick={onBack}>
        Back
      </Button>
      <Button variant="primary" disabled={busy || nextDisabled} onClick={onNext}>
        {next}
      </Button>
    </>
  )
}
