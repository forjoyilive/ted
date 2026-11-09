import type { Factory } from '@ted/protocol'
import type { ReactNode } from 'react'
import { Button } from '../components/Button.tsx'
import { StatusChip } from '../components/StatusChip.tsx'
import { usePlans } from '../data.ts'
import { planStatusChip } from '../plans.ts'
import styles from './views.module.css'

export function Stub({ title, banners }: { title: string; banners?: ReactNode }) {
  return (
    <section className={styles.pane} aria-label={title}>
      <header className={styles.header}>
        <h1 className={styles.title}>{title}</h1>
      </header>
      {banners}
      <p className={styles.empty}>Not built yet.</p>
    </section>
  )
}

export function PlansStub({
  factory,
  banners,
  onPlan,
  onOpenPlan,
}: {
  factory: Factory
  banners?: ReactNode
  onPlan: () => void
  onOpenPlan: (planId: string) => void
}) {
  const plans = usePlans(factory.id)
  const title = `${factory.name} · Plans`
  return (
    <section className={styles.pane} aria-label={title}>
      <header className={styles.header}>
        <h1 className={styles.title}>{title}</h1>
        <span className={styles.headerSpacer} />
        <Button size="small" disabled={!factory.cloned} onClick={onPlan}>
          Plan
        </Button>
      </header>
      {banners}
      {plans.length === 0 ? (
        <p className={styles.empty}>No planning chats yet.</p>
      ) : (
        <ul className={styles.runList}>
          {[...plans].reverse().map((plan) => {
            const chip = planStatusChip(plan)
            return (
              <li key={plan.id}>
                <button type="button" className={styles.runRow} onClick={() => onOpenPlan(plan.id)}>
                  <span />
                  <span className={styles.runName}>{plan.title}</span>
                  <StatusChip tone={chip.tone} {...(chip.glyph && { glyph: chip.glyph })}>
                    {chip.label}
                  </StatusChip>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
