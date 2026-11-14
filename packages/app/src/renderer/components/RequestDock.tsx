import type { Comment, Task } from '@ted/protocol'
import type { ReactNode } from 'react'
import { headline, requestLabel } from '../requests.ts'
import { dockable, RequestAnswer } from './RequestCard.tsx'
import styles from './RequestDock.module.css'

export function RequestDock({
  task,
  open,
  current,
  onCurrent,
  onJump,
  onOpenRun,
  children,
}: {
  task: Task
  open: readonly Comment[]
  current: string | undefined
  onCurrent: (id: string) => void
  onJump: (id: string) => void
  onOpenRun?: ((runId: string) => void) | undefined
  children: ReactNode
}) {
  const requests = [...open].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const shown = requests.find((request) => request.id === current) ?? requests[0]
  const at = shown ? requests.indexOf(shown) : 0
  const move = (to: number) => {
    const next = requests[to]
    if (next) onCurrent(next.id)
  }
  const switcher = requests.length > 1 && (
    <span className={styles.switch}>
      <button
        type="button"
        className={styles.step}
        aria-label="Previous request"
        disabled={at === 0}
        onClick={() => move(at - 1)}
      >
        ‹
      </button>
      {`${at + 1} of ${requests.length}`}
      <button
        type="button"
        className={styles.step}
        aria-label="Next request"
        disabled={at === requests.length - 1}
        onClick={() => move(at + 1)}
      >
        ›
      </button>
    </span>
  )
  const label = shown && requestLabel(shown)
  const title = shown && headline(shown)
  const answering = shown !== undefined && dockable(shown)

  return (
    <>
      <div
        className={styles.stack}
        hidden={answering}
        data-others={requests.length > 1 ? '' : undefined}
      >
        {shown && !answering && (
          <div className={styles.pointer} role="note" aria-label="Open request">
            <span className={styles.pointerText}>
              <strong>{label}</strong>: {title} has its own form in the thread. This box sends a
              Comment and doesn’t answer it.
            </span>
            {switcher}
            <button type="button" className={styles.link} onClick={() => onJump(shown.id)}>
              Jump to it ↑
            </button>
          </div>
        )}
        {children}
      </div>
      {shown && (
        <section
          className={styles.dock}
          aria-label="Answer"
          hidden={!answering}
          data-request={answering ? shown.id : undefined}
          data-others={requests.length > 1 ? '' : undefined}
        >
          <div className={styles.head}>
            <span className={styles.kind}>{`Answer · ${label}`}</span>
            <span className={styles.title} title={title}>
              {title}
            </span>
            {switcher}
            <button type="button" className={styles.link} onClick={() => onJump(shown.id)}>
              Show request ↑
            </button>
          </div>
          {requests.filter(dockable).map((request) => (
            <div key={request.id} className={styles.answer} hidden={request.id !== shown.id}>
              <RequestAnswer
                request={request}
                task={task}
                onOpenRun={onOpenRun}
                lead={(comment) => (
                  <button
                    type="button"
                    className={`${styles.link} ${styles.comment}`}
                    disabled={comment.disabled}
                    aria-busy={comment.pending || undefined}
                    title="Post this text as a Comment and leave the request open"
                    onClick={comment.send}
                  >
                    Comment without answering
                  </button>
                )}
              />
            </div>
          ))}
        </section>
      )}
    </>
  )
}
