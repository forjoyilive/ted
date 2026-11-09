import type { Factory, InboxItem } from '@ted/protocol'
import { type ReactNode, useEffect, useRef } from 'react'
import { Button } from '../components/Button.tsx'
import { EmptyState } from '../components/EmptyState.tsx'
import { Help } from '../components/Help.tsx'
import { PriorityIcon } from '../components/PriorityIcon.tsx'
import { type InboxEmpty, inboxEmpty } from '../empty-states.ts'
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
  anyTasks,
  selected,
  onOpen,
  onFilter,
  onShowAnswered,
  onNewTask,
  children,
}: {
  items: readonly InboxItem[]
  answered: readonly InboxItem[]
  factories: readonly Factory[]
  factoryId: string | undefined
  showAnswered: boolean
  anyTasks: boolean
  selected: string | undefined
  onOpen: (item: InboxItem) => void
  onFilter: (factoryId: string | undefined) => void
  onShowAnswered: (show: boolean) => void
  onNewTask: () => void
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
          <InboxEmptyState
            empty={inboxEmpty({
              showAnswered,
              anyTasks,
              factoryName: factoryId === undefined ? undefined : factoryName(factories, factoryId),
            })}
            onNewTask={onNewTask}
            onShowAnswered={() => onShowAnswered(true)}
            onShowAllFactories={() => onFilter(undefined)}
          />
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

function InboxEmptyState({
  empty,
  onNewTask,
  onShowAnswered,
  onShowAllFactories,
}: {
  empty: InboxEmpty
  onNewTask: () => void
  onShowAnswered: () => void
  onShowAllFactories: () => void
}) {
  const button = {
    'new-task': (
      <Button variant="primary" size="small" onClick={onNewTask}>
        New Task
      </Button>
    ),
    'show-answered': (
      <Button size="small" onClick={onShowAnswered}>
        Show answered
      </Button>
    ),
    'show-all-factories': (
      <Button size="small" onClick={onShowAllFactories}>
        Show all Factories
      </Button>
    ),
  }
  return empty.action === undefined ? (
    <EmptyState title={empty.title} />
  ) : (
    <EmptyState title={empty.title}>{button[empty.action]}</EmptyState>
  )
}
