import type { ReactNode } from 'react'
import { type DetailsSectionId, useCollapsed } from '../details.ts'
import styles from './DetailsSection.module.css'
import { ChevronIcon } from './icons.tsx'

export function DetailsSection({
  id,
  title,
  summary,
  collapsedSummary = summary,
  action,
  children,
}: {
  id: DetailsSectionId
  title: string
  summary?: string | undefined
  collapsedSummary?: string | undefined
  action?: ReactNode
  children: ReactNode
}) {
  const [collapsed, toggle] = useCollapsed(id)
  const shown = collapsed ? collapsedSummary : summary
  return (
    <section className={styles.section} aria-label={title} data-collapsed={collapsed || undefined}>
      <div className={styles.headingRow}>
        <h2 className={styles.heading}>
          <button
            type="button"
            className={styles.toggle}
            aria-expanded={!collapsed}
            onClick={toggle}
          >
            <span className={styles.title}>{title}</span>
            {shown !== undefined && shown !== '' && (
              <span className={styles.summary}> · {shown}</span>
            )}
            <ChevronIcon open={!collapsed} className={styles.chevron} />
          </button>
        </h2>
        {!collapsed && action}
      </div>
      {!collapsed && children}
    </section>
  )
}
