import type { Factory, InboxItem } from '@ted/protocol'
import { type ReactNode, useEffect, useRef } from 'react'
import { Help } from '../components/Help.tsx'
import { PriorityIcon } from '../components/PriorityIcon.tsx'
import { inboxChips, inFactory, nextSelection } from '../inbox.ts'
import { age, headline, requestLabel, useNow } from '../requests.ts'
import styles from './Inbox.module.css'
import { factoryName, stageName } from './TaskViews.tsx'
import views from './views.module.css'

export function Inbox({
  items,
  answered,
  factories,
  factoryId,
  showAnswered,
  selected,
  onOpen,
  onFilter,
  onShowAnswered,
  children,
}: {
  items: readonly InboxItem[]
  answered: readonly InboxItem[]
  factories: readonly Factory[]
  factoryId: string | undefined
  showAnswered: boolean
  selected: string | undefined
  onOpen: (item: InboxItem) => void
  onFilter: (factoryId: string | undefined) => void
  onShowAnswered: (show: boolean) => void
  children?: ReactNode
}) {
  const now = useNow()
  const manyFactories = factories.length > 1
  const waiting = inFactory(items, factoryId)
  const shown = showAnswered ? inFactory(answered, factoryId) : waiting

  const before = useRef(waiting)
  const open = useRef(onOpen)
  open.current = onOpen
  useEffect(() => {
    const next = showAnswered ? undefined : nextSelection(before.current, waiting, selected)
    if (!showAnswered) before.current = waiting
    if (next) open.current(next)
  }, [waiting, selected, showAnswered])

  return (
    <>
      <section className={`${views.pane} ${views.listPane}`} aria-label="Inbox">
        <header className={styles.header}>
          <div className={styles.titleRow}>
            <h1 className={views.listTitle}>Inbox</h1>
            <Help>
              Questions and sign-offs from agents that need your answer, from every Factory.
            </Help>
            <button
              type="button"
              role="switch"
              aria-checked={showAnswered}
              className={styles.answeredSwitch}
              onClick={() => onShowAnswered(!showAnswered)}
            >
              <span className={styles.track} aria-hidden>
                <span className={styles.knob} />
              </span>
              Answered
            </button>
          </div>
          {manyFactories && (
            <div className={styles.chips}>
              {inboxChips(items, factories).map((chip) => (
                <button
                  key={chip.factoryId ?? 'all'}
                  type="button"
                  className={styles.chip}
                  aria-pressed={chip.factoryId === factoryId}
                  onClick={() => onFilter(chip.factoryId)}
                >
                  {chip.label} <span className={styles.chipCount}>{chip.count}</span>
                </button>
              ))}
            </div>
          )}
        </header>
        {shown.length === 0 ? (
          <p className={views.empty}>
            {showAnswered
              ? 'Nothing answered in the last 30 days.'
              : factoryId === undefined
                ? 'Nothing is waiting on you.'
                : `Nothing from ${factoryName(factories, factoryId)} is waiting on you.`}
          </p>
        ) : (
          <ul className={styles.rows}>
            {shown.map((item) => {
              const { request, task } = item
              const where = [
                task.displayId,
                task.title,
                stageName(request.stage ?? task.stage),
                ...(manyFactories ? [factoryName(factories, task.factoryId)] : []),
              ].join(' · ')
              const unread = !showAnswered && request.readAt === undefined
              return (
                <li key={request.id}>
                  <button
                    type="button"
                    className={styles.row}
                    aria-current={request.id === selected ? 'true' : undefined}
                    onClick={() => onOpen(item)}
                  >
                    <span className={styles.top}>
                      <PriorityIcon priority={task.priority} />
                      <span
                        className={
                          request.failed ? `${styles.kind} ${styles.failedKind}` : styles.kind
                        }
                      >
                        {requestLabel(request)}
                      </span>
                      <span className={styles.age}>
                        {age(request.answer?.at ?? request.createdAt, now)}
                      </span>
                    </span>
                    <span
                      data-headline
                      className={unread ? `${styles.headline} ${styles.unread}` : styles.headline}
                    >
                      {headline(request)}
                    </span>
                    <span className={styles.where}>{where}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>
      {children ?? <section className={views.pane} aria-label="Nothing open" />}
    </>
  )
}
