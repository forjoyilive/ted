import type { ReactNode } from 'react'
import { type DetailsTabId, detailsTabNames } from '../details.ts'
import styles from './DetailsSection.module.css'
import { detailsPanelId } from './DetailsTabs.tsx'

export function DetailsSection({
  id,
  summary,
  action,
  children,
}: {
  id: DetailsTabId
  summary?: string | undefined
  action?: ReactNode
  children: ReactNode
}) {
  const title = detailsTabNames[id]
  return (
    <section className={styles.section} role="tabpanel" id={detailsPanelId(id)} aria-label={title}>
      <div className={styles.headingRow}>
        <h2 className={styles.heading}>{title}</h2>
        {action}
      </div>
      {summary !== undefined && summary !== '' && <p className={styles.summary}>{summary}</p>}
      <div className={styles.body}>{children}</div>
    </section>
  )
}
