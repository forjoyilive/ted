import type { Task, TaskBrief } from '@ted/protocol'
import { briefHeadings } from '@ted/protocol/task'
import { useComments } from '../data.ts'
import { briefLines, briefPart, briefUpdatedLine } from '../details.ts'
import { useNow } from '../requests.ts'
import { useStages } from '../stages.tsx'
import styles from './FullBrief.module.css'
import { LoadingError, Skeleton } from './Loading.tsx'

export function FullBrief({
  task,
  brief,
  error,
  retry,
  onBack,
}: {
  task: Task
  brief: TaskBrief | null | undefined
  error?: string | undefined
  retry?: (() => void) | undefined
  onBack: () => void
}) {
  const comments = useComments(task.id)
  const now = useNow()
  const stages = useStages()
  return (
    <section className={styles.pane} aria-label="Full brief">
      <header className={styles.header}>
        <button type="button" className={styles.back} onClick={onBack}>
          ← Task Lead
        </button>
        <div className={styles.titleRow}>
          <h2 className={styles.title}>Task brief</h2>
          {brief && (
            <p className={styles.updated}>
              {briefUpdatedLine(brief, comments, now, (stage) =>
                stages.name(stage, task.factoryId),
              )}
            </p>
          )}
        </div>
      </header>
      <div className={styles.body}>
        {error && retry && <LoadingError error={error} retry={retry} />}
        {brief === undefined ? (
          !(error && retry) && <Skeleton label="Loading Task brief…" />
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
