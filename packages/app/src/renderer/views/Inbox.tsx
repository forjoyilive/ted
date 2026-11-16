import type {
  AutomationRequest,
  Factory,
  FactoryLayout,
  InboxItem,
  MachineSettings,
  Plan,
  PlanInboxItem,
  Task,
} from '@ted/protocol'
import { factoryNotifications } from '@ted/protocol/settings'
import { Fragment, type ReactNode, useContext, useLayoutEffect, useRef, useState } from 'react'
import dialogStyles from '../components/ArchiveDialogs.module.css'
import { Dialog } from '../components/ArchiveDialogs.tsx'
import { Button } from '../components/Button.tsx'
import {
  buttonPosition,
  contextMenu,
  type MenuAction,
  type MenuPosition,
  useActionMenu,
} from '../components/ContextMenu.tsx'
import { EmptyState } from '../components/EmptyState.tsx'
import { FactoryName } from '../components/FactoryIcon.tsx'
import { Help } from '../components/Help.tsx'
import { BellOffIcon, ChevronIcon, ClockIcon } from '../components/icons.tsx'
import { PriorityIcon } from '../components/PriorityIcon.tsx'
import { TaskDialog, type TaskDialogKind } from '../components/TaskActions.tsx'
import type { ConfirmationRequest } from '../data.ts'
import { type InboxEmpty, inboxEmpty } from '../empty-states.ts'
import { emptyLayout, groups as factoryGroups, factoryScope } from '../factory-layout.ts'
import {
  type Grouped,
  groupInbox,
  type InboxOrder,
  inboxChips,
  inboxGroupingLabels,
  inboxGroupings,
  inFactory,
  nextSelection,
  requestKind,
} from '../inbox.ts'
import { useInboxGrouping } from '../inbox-grouping.ts'
import { InboxRequestsContext } from '../inbox-requests.ts'
import { inboxLabel, planEnded } from '../plans.ts'
import { openSnoozeMenu, SnoozedContext, snoozeTime } from '../request-snooze.ts'
import { age, headline, requestLabel, useNow } from '../requests.ts'
import { onRequestAnswered, readableError, ted } from '../ted.ts'
import styles from './Inbox.module.css'
import { FilterIcon, MenuButton } from './TaskList.tsx'
import { factoryName, stageName } from './TaskViews.tsx'
import views from './views.module.css'

export interface InboxScope {
  factoryId?: string
  groupId?: string
}

export function Inbox({
  items,
  plans = [],
  answered,
  factories,
  layout = emptyLayout,
  factoryId,
  groupId,
  showAnswered,
  anyTasks,
  selected,
  onOpen,
  onClear,
  questions = [],
  onOpenQuestion,
  confirmations = [],
  onOpenConfirmation,
  onOpenPlan,
  onFilter,
  onShowAnswered,
  onClearFilters,
  onNewTask,
  onOpenNotifications,
  settings,
  children,
}: {
  items: readonly InboxItem[]
  plans?: readonly PlanInboxItem[]
  answered: readonly InboxItem[]
  factories: readonly Factory[]
  layout?: FactoryLayout
  factoryId: string | undefined
  groupId?: string | undefined
  showAnswered: boolean
  anyTasks: boolean
  selected: string | undefined
  onOpen: (item: InboxItem) => void
  onClear: () => void
  questions?: readonly AutomationRequest[]
  onOpenQuestion?: (question: AutomationRequest) => void
  confirmations?: readonly ConfirmationRequest[]
  onOpenConfirmation?: (request: ConfirmationRequest) => void
  onOpenPlan?: (item: PlanInboxItem) => void
  onFilter: (scope: InboxScope) => void
  onShowAnswered: (show: boolean) => void
  onClearFilters?: () => void
  onNewTask: () => void
  onOpenNotifications?: () => void
  settings?: MachineSettings | undefined
  children?: ReactNode
}) {
  const view = useInboxGrouping(showAnswered ? 'answered' : 'waiting')
  const snoozed = useContext(SnoozedContext)
  const [showSnoozed, setShowSnoozed] = useState(false)
  const snoozeMenu = (requestId: string, at: MenuPosition) =>
    openSnoozeMenu({ requestId, at, snoozedUntil: snoozed.get(requestId) })
  const [taskDialog, setTaskDialog] = useState<{ task: Task; kind: TaskDialogKind }>()
  const [deletingPlan, setDeletingPlan] = useState<Plan>()
  const dialogTask =
    taskDialog &&
    ([...items, ...answered].find((i) => i.task.id === taskDialog.task.id)?.task ?? taskDialog.task)
  const taskActions = (task: Task): MenuAction[] => [
    ...(!task.archived && task.preparation === 'ready'
      ? [{ label: 'Stop Task', action: () => ted.stopTask(task.id) }]
      : []),
    {
      label: 'Copy Task ID',
      action: () => navigator.clipboard.writeText(task.displayId),
    },
    ...(task.archived
      ? []
      : [{ label: 'Archive…', action: () => setTaskDialog({ task, kind: 'archive' }) }]),
    { label: 'Delete…', danger: true, action: () => setTaskDialog({ task, kind: 'delete' }) },
  ]
  const planActions = (plan: Plan): MenuAction[] => [
    ...(planEnded(plan) ? [] : [{ label: 'Stop plan', action: () => ted.stopPlan(plan.id) }]),
    { label: 'Delete plan…', danger: true, action: () => setDeletingPlan(plan) },
  ]
  const requestMenu = (id: string, label: string, body: string, more: MenuAction[] = []) =>
    contextMenu((at) =>
      actions.open(at, label, [
        ...(showAnswered
          ? []
          : [
              {
                label: snoozed.has(id) ? 'Change snooze…' : 'Snooze…',
                action: () => snoozeMenu(id, at),
              },
              ...(snoozed.has(id)
                ? [{ label: 'Unsnooze', action: () => ted.snoozeRequest(id, null) }]
                : []),
            ]),
        { label: 'Copy message text', action: () => navigator.clipboard.writeText(body) },
        ...more.map((item, index) => (index === 0 ? { ...item, divider: true } : item)),
      ]),
    )
  const now = useNow()
  const quiet = (id: string) =>
    settings !== undefined && !factoryNotifications(settings, id).inboxItems
  const mark = (id: string) =>
    !showAnswered &&
    quiet(id) && (
      <span className={styles.uncounted} title="Inbox items are off for this Factory">
        <BellOffIcon />
        Not counted
      </span>
    )
  const manyFactories = factories.length > 1
  const factoryPart = (id: string): ReactNode[] =>
    manyFactories ? [<FactoryName key="factory" factories={factories} factoryId={id} />] : []
  const [resolved, setResolved] = useState<ReadonlySet<string>>(() => new Set())
  const known = useRef(new Set<string>())
  for (const item of items) known.current.add(item.request.id)
  for (const item of plans) known.current.add(item.request.id)
  for (const question of questions) known.current.add(question.id)
  for (const confirmation of confirmations) known.current.add(confirmation.id)

  useLayoutEffect(() => {
    const resolve = (ids: readonly string[]) =>
      setResolved((current) => {
        const added = ids.filter((id) => known.current.has(id) && !current.has(id))
        return added.length ? new Set([...current, ...added]) : current
      })
    const unsubscribe = ted.onEvent((event) => {
      if (event.type === 'comment-updated' && event.comment.answer) resolve([event.comment.id])
      if (event.type === 'inbox-changed') {
        const waiting = new Set([...event.waiting, ...event.snoozed].map((request) => request.id))
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
  const awake = <T,>(list: readonly T[], id: (item: T) => string) =>
    list.filter((item) => !snoozed.has(id(item)))
  const groupName = factoryGroups(layout).find((g) => g.id === groupId)?.name
  const scope = factoryScope(layout, {
    ...(factoryId !== undefined && { factoryId }),
    ...(groupName !== undefined && groupId !== undefined && { groupId }),
  })
  const inScope = (id: string) => scope === undefined || scope(id)
  const waiting = inFactory(pending, scope)
  const shown = showAnswered ? inFactory(answered, scope) : waiting
  const asked = showAnswered ? [] : pendingQuestions.filter((q) => inScope(q.factoryId))
  const planRows = showAnswered ? [] : pendingPlans.filter((p) => inScope(p.plan.factoryId))
  const confirmationRows = showAnswered
    ? []
    : confirmations.filter((c) => !resolved.has(c.id) && inScope(c.factoryId))

  const actions = useActionMenu(
    JSON.stringify([
      shown.map((item) => item.request.id),
      planRows.map((item) => item.request.id),
      asked.map((question) => question.id),
      confirmationRows.map((c) => c.id),
    ]),
  )

  const taskRows = shown.map((item) => ({
    kind: 'task' as const,
    item,
    request: item.request,
    grouped: {
      kind: requestKind(item.request),
      at: (showAnswered ? item.request.answer?.at : undefined) ?? item.request.createdAt,
      stage: item.request.stage ?? item.task.stage,
      priority: item.task.priority,
      factoryId: item.task.factoryId,
    } satisfies Grouped,
    open: () => onOpen(item),
  }))
  const allRows = showAnswered
    ? taskRows
    : [
        ...planRows.map((item) => ({
          kind: 'plan' as const,
          item,
          request: item.request,
          grouped: {
            kind: 'question',
            at: item.request.createdAt,
            factoryId: item.plan.factoryId,
          } satisfies Grouped,
          open: () => onOpenPlan?.(item),
        })),
        ...taskRows,
        ...asked.map((item) => ({
          kind: 'automation' as const,
          item,
          request: item,
          grouped: {
            kind: 'question',
            at: item.createdAt,
            factoryId: item.factoryId,
          } satisfies Grouped,
          open: () => onOpenQuestion?.(item),
        })),
        ...confirmationRows.map((item) => ({
          kind: 'coordinator' as const,
          item,
          request: item,
          grouped: {
            kind: 'question',
            at: item.createdAt,
            factoryId: item.factoryId,
          } satisfies Grouped,
          open: () => onOpenConfirmation?.(item),
        })),
      ].sort(
        (a, b) =>
          b.request.createdAt.localeCompare(a.request.createdAt) ||
          a.request.id.localeCompare(b.request.id),
      )
  const rows = showAnswered ? allRows : allRows.filter((row) => !snoozed.has(row.request.id))
  const snoozedRows = showAnswered
    ? []
    : allRows
        .filter((row) => snoozed.has(row.request.id))
        .sort(
          (a, b) =>
            (view.order.oldestFirst ? -1 : 1) *
            (snoozed.get(a.request.id) ?? '').localeCompare(snoozed.get(b.request.id) ?? ''),
        )
  const uncounted = showAnswered
    ? []
    : rows
        .map((row) =>
          row.kind === 'plan'
            ? row.item.plan.factoryId
            : row.kind === 'task'
              ? row.item.task.factoryId
              : row.item.factoryId,
        )
        .filter(quiet)
  const groups = groupInbox(rows, view.grouping, now, view.order, layout)
  const ordered = groups.flatMap((group) => group.rows)
  const visible = groups.flatMap((group) => (view.collapsed(group.key) ? [] : group.rows))
  const shownSnoozed = showSnoozed ? snoozedRows : []
  const selectable = [...visible, ...shownSnoozed]
  const all = [...ordered, ...shownSnoozed]
  const before = useRef(all)
  const next =
    showAnswered || ordered.some((row) => row.request.id === selected)
      ? undefined
      : nextSelection(before.current, selectable, selected)
  useLayoutEffect(() => {
    if (showAnswered) return
    before.current = all
    if (next === null) onClear()
    else next?.open()
  })

  const until = (id: string) => {
    const at = snoozed.get(id)
    return at === undefined || showAnswered ? null : (
      <span className={styles.until}>Returns {snoozeTime(at)}</span>
    )
  }
  const rowButton = (row: (typeof allRows)[number], old = false) => {
    const ageClass = old ? `${styles.age} ${styles.old}` : styles.age
    if (row.kind === 'plan') {
      const item = row.item
      const { request, plan } = item
      const where = [plan.title, ...factoryPart(plan.factoryId)]
      return (
        <button
          type="button"
          className={styles.row}
          data-nav-item
          data-snooze-request={request.id}
          data-plan-request={request.id}
          aria-current={request.id === selected ? 'true' : undefined}
          {...requestMenu(
            request.id,
            request.title ?? 'Planning request',
            request.body || request.title || '',
            planActions(plan),
          )}
          onClick={() => onOpenPlan?.(item)}
        >
          <span className={styles.top}>
            <span className={styles.kind}>{inboxLabel(request)}</span>
            {mark(plan.factoryId)}
            <span className={ageClass}>{age(request.createdAt, now)}</span>
          </span>
          <span data-headline className={`${styles.headline} ${styles.unread}`}>
            {request.title ?? ''}
          </span>
          <span className={styles.where}>{joined(where)}</span>
          {until(row.request.id)}
        </button>
      )
    }
    if (row.kind === 'task') {
      const item = row.item
      const { request, task } = item
      const where = [
        task.displayId,
        task.title,
        stageName(request.stage ?? task.stage),
        ...factoryPart(task.factoryId),
      ]
      const unread = !showAnswered && request.readAt === undefined
      return (
        <button
          type="button"
          className={styles.row}
          data-nav-item
          data-snooze-request={showAnswered ? undefined : request.id}
          aria-current={request.id === selected ? 'true' : undefined}
          {...requestMenu(
            request.id,
            `${task.displayId} · ${headline(request)}`,
            request.body || request.title || '',
            taskActions(task),
          )}
          onClick={() => onOpen(item)}
        >
          <span className={styles.top}>
            <PriorityIcon priority={task.priority} />
            <span className={request.failed ? `${styles.kind} ${styles.failedKind}` : styles.kind}>
              {requestLabel(request)}
            </span>
            {mark(task.factoryId)}
            <span className={ageClass}>{age(request.answer?.at ?? request.createdAt, now)}</span>
          </span>
          <span
            data-headline
            className={unread ? `${styles.headline} ${styles.unread}` : styles.headline}
          >
            {headline(request)}
          </span>
          <span className={styles.where}>{joined(where)}</span>
          {until(row.request.id)}
        </button>
      )
    }
    if (row.kind === 'coordinator') {
      const confirmation = row.item
      const where = ['Coordinator', ...factoryPart(confirmation.factoryId)]
      return (
        <button
          type="button"
          className={styles.row}
          aria-current={confirmation.id === selected ? 'true' : undefined}
          data-nav-item
          data-snooze-request={confirmation.id}
          data-confirmation-request={confirmation.id}
          {...requestMenu(confirmation.id, 'Coordinator', confirmation.headline)}
          onClick={() => onOpenConfirmation?.(confirmation)}
        >
          <span className={styles.top}>
            <span className={styles.kind}>Confirmation</span>
            {mark(confirmation.factoryId)}
            <span className={ageClass}>{age(confirmation.createdAt, now)}</span>
          </span>
          <span data-headline className={`${styles.headline} ${styles.unread}`}>
            {confirmation.headline}
          </span>
          <span className={styles.where}>{joined(where)}</span>
          {until(row.request.id)}
        </button>
      )
    }
    const question = row.item
    const where = [question.automationName, 'Automation', ...factoryPart(question.factoryId)]
    return (
      <button
        type="button"
        className={styles.row}
        aria-current={question.id === selected ? 'true' : undefined}
        data-nav-item
        data-snooze-request={question.id}
        {...requestMenu(question.id, question.automationName, question.body)}
        onClick={() => onOpenQuestion?.(question)}
      >
        <span className={styles.top}>
          <span className={styles.kind}>Question</span>
          {mark(question.factoryId)}
          <span className={ageClass}>{age(question.createdAt, now)}</span>
        </span>
        <span data-headline className={`${styles.headline} ${styles.unread}`}>
          {question.body.split('\n')[0]}
        </span>
        <span className={styles.where}>{joined(where)}</span>
        {until(row.request.id)}
      </button>
    )
  }

  const orderChoice = (label: string, on: boolean, change: Partial<InboxOrder>) => (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={on}
      className={styles.choice}
      onClick={() => view.setOrder(change)}
    >
      <span className={styles.choiceLabel}>{label}</span>
      {on && <span className={styles.tick}>✓</span>}
    </button>
  )

  const active = [
    ...(view.grouping === 'none' ? [] : [`Grouped by ${inboxGroupingLabels[view.grouping]}`]),
    ...(view.grouping !== 'none' && view.order.groupsReversed ? ['Groups descending'] : []),
    ...(view.order.oldestFirst ? ['Oldest first'] : []),
    ...(groupName === undefined ? [] : [groupName]),
    ...(factoryId === undefined ? [] : [factoryName(factories, factoryId)]),
    ...(showAnswered ? ['Answered'] : []),
  ]
  const clear = () => {
    view.reset()
    if (onClearFilters) return onClearFilters()
    if (factoryId !== undefined || groupId !== undefined) onFilter({})
    if (showAnswered) onShowAnswered(false)
  }

  return (
    <>
      {actions.menu}
      {taskDialog && dialogTask && (
        <TaskDialog
          task={dialogTask}
          kind={taskDialog.kind}
          onKind={(kind) => setTaskDialog(kind === undefined ? undefined : { ...taskDialog, kind })}
        />
      )}
      {deletingPlan && (
        <DeletePlanDialog plan={deletingPlan} onClose={() => setDeletingPlan(undefined)} />
      )}
      <section className={`${views.pane} ${views.listPane}`} aria-label="Inbox" data-fixed-pane>
        <header className={styles.header}>
          <div className={styles.titleRow}>
            <h1 className={views.listTitle}>Inbox</h1>
            <Help>
              Questions and sign-offs from agents that need your answer, from every Factory.
            </Help>
            <div className={styles.filter}>
              <MenuButton label="Filter" icon={<FilterIcon />} badge={active.length}>
                {() => (
                  <>
                    <div className={styles.panelHeading}>Group by</div>
                    {inboxGroupings.map((grouping) => (
                      <button
                        key={grouping}
                        type="button"
                        role="menuitemradio"
                        aria-checked={view.grouping === grouping}
                        className={styles.choice}
                        onClick={() => view.setGrouping(grouping)}
                      >
                        <span className={styles.choiceLabel}>{inboxGroupingLabels[grouping]}</span>
                        {view.grouping === grouping && <span className={styles.tick}>✓</span>}
                      </button>
                    ))}
                    {view.grouping !== 'none' && (
                      <>
                        <div className={styles.panelHeading}>Groups</div>
                        {orderChoice('Ascending', !view.order.groupsReversed, {
                          groupsReversed: false,
                        })}
                        {orderChoice('Descending', view.order.groupsReversed, {
                          groupsReversed: true,
                        })}
                      </>
                    )}
                    <div className={styles.panelHeading}>Requests</div>
                    {orderChoice('Newest first', !view.order.oldestFirst, { oldestFirst: false })}
                    {orderChoice('Oldest first', view.order.oldestFirst, { oldestFirst: true })}
                    {manyFactories && (
                      <>
                        <div className={styles.panelHeading}>Factory</div>
                        <div className={styles.chips}>
                          {inboxChips(
                            awake(pending, (item) => item.request.id),
                            factories,
                            awake(pendingQuestions, (question) => question.id),
                            awake(pendingPlans, (item) => item.request.id),
                            layout,
                          ).map((chip) => (
                            <button
                              key={
                                chip.groupId === undefined
                                  ? (chip.factoryId ?? 'all')
                                  : `group:${chip.groupId}`
                              }
                              type="button"
                              className={
                                chip.groupId === undefined
                                  ? styles.chip
                                  : `${styles.chip} ${styles.groupChip}`
                              }
                              data-factory-group={chip.groupId}
                              aria-pressed={
                                chip.factoryId === factoryId &&
                                chip.groupId === (groupName === undefined ? undefined : groupId)
                              }
                              onClick={() =>
                                onFilter({
                                  ...(chip.factoryId !== undefined && {
                                    factoryId: chip.factoryId,
                                  }),
                                  ...(chip.groupId !== undefined && { groupId: chip.groupId }),
                                })
                              }
                            >
                              {chip.factoryId !== undefined && quiet(chip.factoryId) && (
                                <BellOffIcon />
                              )}
                              {chip.label} <span className={styles.chipCount}>{chip.count}</span>
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                    <div className={styles.panelHeading}>Show</div>
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
                  </>
                )}
              </MenuButton>
            </div>
          </div>
          {active.length > 0 && (
            <div className={styles.summary}>
              <span className={styles.summaryText}>{active.join(' · ')}</span>
              <button type="button" className={styles.clear} onClick={clear}>
                Clear
              </button>
            </div>
          )}
        </header>
        {uncounted.length > 0 && (
          <p className={styles.uncountedNote}>
            <BellOffIcon />
            <span>
              {uncounted.length} not counted or notified: Inbox items are off for{' '}
              {[...new Set(uncounted)].map((id) => factoryName(factories, id)).join(', ')}.
            </span>
            {onOpenNotifications && (
              <button
                type="button"
                className={styles.uncountedChange}
                onClick={onOpenNotifications}
              >
                Change
              </button>
            )}
          </p>
        )}
        {allRows.length === 0 ? (
          <InboxEmptyState
            empty={inboxEmpty({
              showAnswered,
              anyTasks,
              factoryName:
                groupName !== undefined
                  ? groupName
                  : factoryId === undefined
                    ? undefined
                    : factoryName(factories, factoryId),
            })}
            onNewTask={onNewTask}
            onShowAnswered={() => onShowAnswered(true)}
            onShowAllFactories={() => onFilter({})}
          />
        ) : (
          <ul className={styles.rows}>
            {groups.map((group) => {
              const closed = view.collapsed(group.key)
              return (
                <Fragment key={group.key}>
                  {view.grouping !== 'none' && (
                    <li className={styles.groupItem}>
                      <button
                        type="button"
                        className={styles.groupHead}
                        aria-expanded={!closed}
                        onClick={() => view.setCollapsed(group.key, !closed)}
                      >
                        <ChevronIcon open={!closed} />
                        <span className={styles.groupLabel}>{group.label}</span>
                        <span className={styles.groupCount}>{group.rows.length}</span>
                      </button>
                    </li>
                  )}
                  {!closed &&
                    group.rows.map((row) => (
                      <li key={row.request.id} className={styles.item}>
                        {rowButton(row, group.old === true && !showAnswered)}
                        {!showAnswered && (
                          <button
                            type="button"
                            className={styles.snooze}
                            title="Snooze (H)"
                            aria-label="Snooze"
                            onClick={(event) =>
                              snoozeMenu(row.request.id, buttonPosition(event.currentTarget))
                            }
                          >
                            <ClockIcon className={styles.snoozeIcon} />
                          </button>
                        )}
                      </li>
                    ))}
                </Fragment>
              )
            })}
            {snoozedRows.length > 0 && (
              <li>
                <button
                  type="button"
                  className={styles.group}
                  aria-expanded={showSnoozed}
                  onClick={() => setShowSnoozed(!showSnoozed)}
                >
                  <span aria-hidden>{showSnoozed ? '▾' : '▸'}</span> Snoozed{' '}
                  <span className={styles.chipCount}>{snoozedRows.length}</span>
                </button>
              </li>
            )}
            {showSnoozed &&
              snoozedRows.map((row) => (
                <li key={row.request.id} className={`${styles.item} ${styles.snoozedItem}`}>
                  {rowButton(row)}
                  <div className={styles.rowActions}>
                    <Button
                      size="small"
                      onClick={() => {
                        ted.snoozeRequest(row.request.id, null).catch(console.error)
                      }}
                    >
                      Unsnooze
                    </Button>
                    <Button
                      size="small"
                      onClick={(event) =>
                        snoozeMenu(row.request.id, buttonPosition(event.currentTarget))
                      }
                    >
                      Change snooze…
                    </Button>
                  </div>
                </li>
              ))}
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
                select: (id) => allRows.find((row) => row.request.id === id)?.open(),
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
      <Button variant="primary" onClick={onNewTask}>
        New Task…
      </Button>
    ),
    'show-answered': <Button onClick={onShowAnswered}>Show answered</Button>,
    'show-all-factories': <Button onClick={onShowAllFactories}>Show all Factories</Button>,
  }
  return empty.action === undefined ? (
    <EmptyState title={empty.title} />
  ) : (
    <EmptyState title={empty.title}>{button[empty.action]}</EmptyState>
  )
}

function DeletePlanDialog({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const remove = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await ted.deletePlan(plan.id)
      onClose()
    } catch (failure) {
      setError(readableError(failure))
      setBusy(false)
    }
  }
  return (
    <Dialog
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      {(headingId) => (
        <>
          <h2 id={headingId} className={dialogStyles.heading}>
            Delete this planning chat?
          </h2>
          <p className={dialogStyles.body}>
            {planEnded(plan)
              ? `Delete ${plan.title} and its conversation? Tasks it created stay.`
              : `Stop the planner and delete ${plan.title} and its conversation? Tasks it created stay.`}
          </p>
          {error && (
            <p role="alert" className={dialogStyles.error}>
              {error}
            </p>
          )}
          <div className={dialogStyles.buttons}>
            <Button disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={busy} variant="danger" onClick={() => remove()}>
              Delete
            </Button>
          </div>
        </>
      )}
    </Dialog>
  )
}

function joined(parts: readonly ReactNode[]): ReactNode {
  return parts.map((part, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: the parts are a fixed short list
    <Fragment key={index}>
      {index > 0 && ' · '}
      {part}
    </Fragment>
  ))
}
