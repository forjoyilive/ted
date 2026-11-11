import type { AutomationRequest, Factory, InboxItem, PlanInboxItem } from '@ted/protocol'
import { type ReactNode, useEffect, useRef } from 'react'
import { Button } from '../components/Button.tsx'
import { contextMenu, useActionMenu } from '../components/ContextMenu.tsx'
import { EmptyState } from '../components/EmptyState.tsx'
import { Help } from '../components/Help.tsx'
import { PriorityIcon } from '../components/PriorityIcon.tsx'
import { type InboxEmpty, inboxEmpty } from '../empty-states.ts'
import { inboxChips, inFactory, nextSelection } from '../inbox.ts'
import { inboxLabel } from '../plans.ts'
import { age, headline, requestLabel, useNow } from '../requests.ts'
import styles from './Inbox.module.css'
import { factoryName, stageName } from './TaskViews.tsx'
import views from './views.module.css'

export function Inbox({
  items,
  plans = [],
  answered,
  factories,
  factoryId,
  showAnswered,
  anyTasks,
  selected,
  onOpen,
  onClear,
  questions = [],
  onOpenQuestion,
  onOpenPlan,
  onFilter,
  onShowAnswered,
  onNewTask,
  children,
}: {
  items: readonly InboxItem[]
  plans?: readonly PlanInboxItem[]
  answered: readonly InboxItem[]
  factories: readonly Factory[]
  factoryId: string | undefined
  showAnswered: boolean
  anyTasks: boolean
  selected: string | undefined
  onOpen: (item: InboxItem) => void
  onClear: () => void
  questions?: readonly AutomationRequest[]
  onOpenQuestion?: (question: AutomationRequest) => void
  onOpenPlan?: (item: PlanInboxItem) => void
  onFilter: (factoryId: string | undefined) => void
  onShowAnswered: (show: boolean) => void
  onNewTask: () => void
  children?: ReactNode
}) {
  const requestMenu = (label: string, body: string, open: (() => void) | undefined) =>
    contextMenu((at) =>
      actions.open(at, label, [
        { label: 'Open request', disabled: !open, action: open },
        { label: 'Copy message text', action: () => navigator.clipboard.writeText(body) },
      ]),
    )
  const now = useNow()
  const manyFactories = factories.length > 1
  const waiting = inFactory(items, factoryId)
  const shown = showAnswered ? inFactory(answered, factoryId) : waiting
  const asked = showAnswered
    ? []
    : questions.filter((q) => factoryId === undefined || q.factoryId === factoryId)
  const planRows = showAnswered
    ? []
    : plans.filter((p) => factoryId === undefined || p.plan.factoryId === factoryId)

  const actions = useActionMenu(
    JSON.stringify([
      shown.map((item) => item.request.id),
      planRows.map((item) => item.request.id),
      asked.map((question) => question.id),
    ]),
  )

  const rows = [
    ...planRows.map((item) => ({ request: item.request, open: () => onOpenPlan?.(item) })),
    ...waiting.map((item) => ({ request: item.request, open: () => onOpen(item) })),
    ...asked.map((question) => ({ request: question, open: () => onOpenQuestion?.(question) })),
  ]
  const before = useRef(rows)
  useEffect(() => {
    if (showAnswered) return
    const next = nextSelection(before.current, rows, selected)
    before.current = rows
    if (next === null) onClear()
    else next?.open()
  })

  return (
    <>
      {actions.menu}
      <section className={`${views.pane} ${views.listPane}`} aria-label="Inbox" data-fixed-pane>
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
              {inboxChips(items, factories, questions, plans).map((chip) => (
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
        {shown.length === 0 && asked.length === 0 && planRows.length === 0 ? (
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
            {planRows.map((item) => {
              const { request, plan } = item
              const where = [
                plan.title,
                ...(manyFactories ? [factoryName(factories, plan.factoryId)] : []),
              ].join(' · ')
              return (
                <li key={request.id}>
                  <button
                    type="button"
                    className={styles.row}
                    data-nav-item
                    {...requestMenu(
                      request.title ?? 'Planning request',
                      request.body || request.title || '',
                      onOpenPlan ? () => onOpenPlan(item) : undefined,
                    )}
                    data-plan-request={request.id}
                    onClick={() => onOpenPlan?.(item)}
                  >
                    <span className={styles.top}>
                      <span className={styles.kind}>{inboxLabel(request)}</span>
                      <span className={styles.age}>{age(request.createdAt, now)}</span>
                    </span>
                    <span data-headline className={`${styles.headline} ${styles.unread}`}>
                      {request.title ?? ''}
                    </span>
                    <span className={styles.where}>{where}</span>
                  </button>
                </li>
              )
            })}
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
                    data-nav-item
                    {...requestMenu(
                      `${task.displayId} · ${headline(request)}`,
                      request.body || request.title || '',
                      () => onOpen(item),
                    )}
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
            {asked.map((question) => {
              const where = [
                question.automationName,
                'Automation',
                ...(manyFactories ? [factoryName(factories, question.factoryId)] : []),
              ].join(' · ')
              return (
                <li key={question.id}>
                  <button
                    type="button"
                    className={styles.row}
                    data-nav-item
                    {...requestMenu(
                      question.automationName,
                      question.body,
                      onOpenQuestion ? () => onOpenQuestion(question) : undefined,
                    )}
                    aria-current={question.id === selected ? 'true' : undefined}
                    onClick={() => onOpenQuestion?.(question)}
                  >
                    <span className={styles.top}>
                      <span className={styles.kind}>Question</span>
                      <span className={styles.age}>{age(question.createdAt, now)}</span>
                    </span>
                    <span data-headline className={`${styles.headline} ${styles.unread}`}>
                      {question.body.split('\n')[0]}
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
