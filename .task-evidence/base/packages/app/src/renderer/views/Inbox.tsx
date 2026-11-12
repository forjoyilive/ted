import type { AutomationRequest, Factory, InboxItem, PlanInboxItem } from '@ted/protocol'
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '../components/Button.tsx'
import { contextMenu, useActionMenu } from '../components/ContextMenu.tsx'
import { EmptyState } from '../components/EmptyState.tsx'
import { Help } from '../components/Help.tsx'
import { PriorityIcon } from '../components/PriorityIcon.tsx'
import { type InboxEmpty, inboxEmpty } from '../empty-states.ts'
import { inboxChips, inFactory, nextSelection } from '../inbox.ts'
import { InboxRequestsContext } from '../inbox-requests.ts'
import { inboxLabel } from '../plans.ts'
import { age, headline, requestLabel, useNow } from '../requests.ts'
import { onRequestAnswered, ted } from '../ted.ts'
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
  const [resolved, setResolved] = useState<ReadonlySet<string>>(() => new Set())
  const known = useRef(new Set<string>())
  for (const item of items) known.current.add(item.request.id)
  for (const item of plans) known.current.add(item.request.id)
  for (const question of questions) known.current.add(question.id)

  useLayoutEffect(() => {
    const resolve = (ids: readonly string[]) =>
      setResolved((current) => {
        const added = ids.filter((id) => known.current.has(id) && !current.has(id))
        return added.length ? new Set([...current, ...added]) : current
      })
    const unsubscribe = ted.onEvent((event) => {
      if (event.type === 'comment-updated' && event.comment.answer) resolve([event.comment.id])
      if (event.type === 'inbox-changed') {
        const waiting = new Set(event.waiting.map((request) => request.id))
        resolve([...known.current.keys()].filter((id) => !waiting.has(id)))
      }
    })
    const stopAnswers = onRequestAnswered(({ request }) => {
      if (request.answer) resolve([request.id])
    })
    return () => {
      unsubscribe()
      stopAnswers()
    }
  }, [])

  const pending = items.filter((item) => !item.request.answer && !resolved.has(item.request.id))
  const pendingPlans = plans.filter(
    (item) => !item.request.answer && !resolved.has(item.request.id),
  )
  const pendingQuestions = questions.filter(
    (question) => !question.answer && !resolved.has(question.id),
  )
  const waiting = inFactory(pending, factoryId)
  const shown = showAnswered ? inFactory(answered, factoryId) : waiting
  const asked = showAnswered
    ? []
    : pendingQuestions.filter((q) => factoryId === undefined || q.factoryId === factoryId)
  const planRows = showAnswered
    ? []
    : pendingPlans.filter((p) => factoryId === undefined || p.plan.factoryId === factoryId)

  const actions = useActionMenu(
    JSON.stringify([
      shown.map((item) => item.request.id),
      planRows.map((item) => item.request.id),
      asked.map((question) => question.id),
    ]),
  )

  const taskRows = shown.map((item) => ({
    kind: 'task' as const,
    item,
    request: item.request,
    open: () => onOpen(item),
  }))
  const rows = showAnswered
    ? taskRows
    : [
        ...planRows.map((item) => ({
          kind: 'plan' as const,
          item,
          request: item.request,
          open: () => onOpenPlan?.(item),
        })),
        ...taskRows,
        ...asked.map((item) => ({
          kind: 'automation' as const,
          item,
          request: item,
          open: () => onOpenQuestion?.(item),
        })),
      ].sort(
        (a, b) =>
          b.request.createdAt.localeCompare(a.request.createdAt) ||
          a.request.id.localeCompare(b.request.id),
      )
  const before = useRef(rows)
  const next = showAnswered ? undefined : nextSelection(before.current, rows, selected)
  useLayoutEffect(() => {
    if (showAnswered) return
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
              {inboxChips(pending, factories, pendingQuestions, pendingPlans).map((chip) => (
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
            {rows.map((row) => {
              if (row.kind === 'plan') {
                const item = row.item
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
                      data-plan-request={request.id}
                      aria-current={request.id === selected ? 'true' : undefined}
                      {...requestMenu(
                        request.title ?? 'Planning request',
                        request.body || request.title || '',
                        onOpenPlan ? () => onOpenPlan(item) : undefined,
                      )}
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
              }
              if (row.kind === 'task') {
                const item = row.item
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
                      aria-current={request.id === selected ? 'true' : undefined}
                      {...requestMenu(
                        `${task.displayId} · ${headline(request)}`,
                        request.body || request.title || '',
                        () => onOpen(item),
                      )}
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
              }
              const question = row.item
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
                    aria-current={question.id === selected ? 'true' : undefined}
                    data-nav-item
                    {...requestMenu(
                      question.automationName,
                      question.body,
                      onOpenQuestion ? () => onOpenQuestion(question) : undefined,
                    )}
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
      <InboxRequestsContext
        value={
          showAnswered
            ? undefined
            : {
                selected,
                resolved,
                select: (id) => rows.find((row) => row.request.id === id)?.open(),
              }
        }
      >
        {children ?? <section className={views.pane} aria-label="Nothing open" />}
      </InboxRequestsContext>
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
