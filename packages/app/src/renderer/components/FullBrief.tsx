import type { Task, TaskBrief } from '@ted/protocol'
import { briefHeadings } from '@ted/protocol/task'
import { useComments } from '../data.ts'
import { briefLines, briefPart, briefUpdatedLine } from '../details.ts'
import { useNow } from '../requests.ts'
import styles from './FullBrief.module.css'

export function FullBrief({
  task,
  brief,
  onBack,
}: {
  task: Task
  brief: TaskBrief | null | undefined
  onBack: () => void
}) {
  const comments = useComments(task.id)
  const now = useNow()
  return (
    <section className={styles.pane} aria-label="Full brief">
      <header className={styles.header}>
        <button type="button" className={styles.back} onClick={onBack}>
          ← Thread
        </button>
        <div className={styles.titleRow}>
          <h2 className={styles.title}>Task brief</h2>
          {brief && <p className={styles.updated}>{briefUpdatedLine(brief, comments, now)}</p>}
        </div>
      </header>
      <div className={styles.body}>
        {brief === undefined ? (
          <p className={styles.empty}>Loading…</p>
        ) : brief === null ? (
          <p className={styles.empty}>The Task Lead hasn’t written a Task brief yet.</p>
        ) : (
          briefHeadings.map((heading) => {
            const lines = briefLines(briefPart(brief.text, heading) ?? '')
            return (
              <section key={heading} className={styles.part} aria-label={heading}>
                <h3 className={styles.heading}>{heading}</h3>
                <p className={styles.text}>{lines.length === 0 ? '—' : lines.join('\n')}</p>
              </section>
            )
          })
        )}
      </div>
    </section>
  )
}
