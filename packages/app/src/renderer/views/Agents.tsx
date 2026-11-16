import type { CoordinatorChatSummary, Factory } from '@ted/protocol'
import { type ReactNode, useEffect, useState } from 'react'
import {
  type AgentChatRef,
  type AgentChatRow,
  agentChatRows,
  groupedRows,
  pickChat,
  useAgentsView,
} from '../agent-chats.ts'
import { ActionButton } from '../components/ActionButton.tsx'
import { AgentAbout } from '../components/AgentAbout.tsx'
import { Button } from '../components/Button.tsx'
import { contextMenu, type MenuPosition, useActionMenu } from '../components/ContextMenu.tsx'
import { DetailsPane } from '../components/ResizableSidebar.tsx'
import type { ScrollReveal } from '../components/ScrollMemory.tsx'
import { StatusChip } from '../components/StatusChip.tsx'
import { useCoordinatorChats, usePlansState } from '../data.ts'
import { newPlan } from '../navigation.ts'
import { when } from '../plans.ts'
import { readableError, ted } from '../ted.ts'
import styles from './Agents.module.css'
import { CoordinatorChat, CoordinatorStart, DeleteCoordinatorChat } from './Coordinator.tsx'
import inbox from './Inbox.module.css'
import { PlanChatView } from './PlanChat.tsx'
import { DisplayIcon, MenuButton } from './TaskList.tsx'
import views from './views.module.css'

export const agentsStart = 'start'
export const newCoordinatorChat = 'new'

export function AgentsView({
  factory,
  chatId,
  planId,
  planFrom,
  revealRequest,
  onOpenChat,
  onNewPlan,
  onPlanMore,
  onOpenTask,
}: {
  factory: Factory
  chatId: string | undefined
  planId: string | undefined
  planFrom: string | undefined
  revealRequest: ScrollReveal | undefined
  onOpenChat: (chat: AgentChatRef, options?: { replace: true }) => void
  onNewPlan: () => void
  onPlanMore: (planId: string) => void
  onOpenTask: (ref: string) => void
}) {
  const coordinatorChats = useCoordinatorChats(factory.id)
  const plans = usePlansState(factory.id)
  const loaded =
    (coordinatorChats.value !== undefined || coordinatorChats.error !== undefined) &&
    (plans.value !== undefined || plans.error !== undefined)
  const rows = agentChatRows(coordinatorChats.value ?? [], plans.value ?? [])
  const view = useAgentsView(factory.id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [deleting, setDeleting] = useState<CoordinatorChatSummary>()
  const rowMenu = useActionMenu('agent-chats')

  const shown: AgentChatRef | 'start' | 'new-coordinator' | 'new-plan' | undefined =
    planId === newPlan
      ? 'new-plan'
      : planId !== undefined
        ? { agent: 'planner', id: planId }
        : chatId === agentsStart
          ? 'start'
          : chatId === newCoordinatorChat
            ? 'new-coordinator'
            : chatId !== undefined
              ? { agent: 'coordinator', id: chatId }
              : loaded
                ? (pickChat(rows, view.remembered) ?? 'start')
                : undefined
  const openRef = typeof shown === 'object' ? shown : undefined
  const picked = chatId === undefined && planId === undefined ? openRef : undefined
  const pickedAgent = picked?.agent
  const pickedId = picked?.id
  useEffect(() => {
    if (pickedAgent !== undefined && pickedId !== undefined)
      onOpenChat({ agent: pickedAgent, id: pickedId }, { replace: true })
  }, [pickedAgent, pickedId, onOpenChat])
  const { remember } = view
  const openAgent = openRef?.agent
  const openId = openRef?.id
  useEffect(() => {
    if (openAgent !== undefined && openId !== undefined) remember({ agent: openAgent, id: openId })
  }, [openAgent, openId, remember])

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    try {
      await work()
      return true
    } catch (failed) {
      setError(readableError(failed))
      return false
    } finally {
      setBusy(false)
    }
  }
  const continueChat = async (id: string) => {
    if (await act(() => ted.continueCoordinatorChat(id))) onOpenChat({ agent: 'coordinator', id })
  }
  const startPage = () => onOpenChat({ agent: 'coordinator', id: agentsStart })
  const coordinatorSummary = (id: string) => coordinatorChats.value?.find((c) => c.id === id)

  const rowFor = (row: AgentChatRow) => {
    const ref = row.ref
    const summary = ref.agent === 'coordinator' ? coordinatorSummary(ref.id) : undefined
    return (
      <ChatRow
        key={`${ref.agent}:${ref.id}`}
        row={row}
        current={openRef?.agent === ref.agent && openRef.id === ref.id}
        onOpen={() => onOpenChat(ref)}
        {...(summary && {
          onMenu: (at: MenuPosition) =>
            rowMenu.open(at, summary.endedAt === undefined ? 'Chat' : 'Ended chat', [
              ...(summary.endedAt !== undefined
                ? [{ label: 'Continue', disabled: busy, action: () => continueChat(summary.id) }]
                : []),
              {
                label: 'Delete…',
                danger: true,
                disabled: busy,
                action: () => setDeleting(summary),
              },
            ]),
        })}
      />
    )
  }

  const list = (
    <section className={`${views.pane} ${views.listPane}`} aria-label="Agent chats" data-fixed-pane>
      <header className={styles.listHeader}>
        <h1 className={views.listTitle}>Agents</h1>
        <span className={styles.spacer} />
        <MenuButton label="Display" icon={<DisplayIcon />}>
          {(close) => (
            <>
              <div className={inbox.panelHeading}>Group by</div>
              {(
                [
                  [false, 'None'],
                  [true, 'Agent'],
                ] as const
              ).map(([byAgent, label]) => (
                <button
                  key={label}
                  type="button"
                  role="menuitemradio"
                  aria-checked={view.byAgent === byAgent}
                  className={inbox.choice}
                  onClick={() => {
                    view.setByAgent(byAgent)
                    close()
                  }}
                >
                  <span className={inbox.choiceLabel}>{label}</span>
                  {view.byAgent === byAgent && <span className={inbox.tick}>✓</span>}
                </button>
              ))}
            </>
          )}
        </MenuButton>
        <Button variant="primary" onClick={startPage}>
          New chat
        </Button>
      </header>
      {rowMenu.menu}
      <div className={styles.rows}>
        {view.byAgent
          ? groupedRows(rows).map((group) => (
              <section key={group.agent} aria-label={`${group.agent} chats`}>
                <h2 className={styles.group}>
                  {group.agent} · {group.rows.length}
                </h2>
                {group.rows.map(rowFor)}
              </section>
            ))
          : rows.map(rowFor)}
        {(coordinatorChats.error ?? plans.error) !== undefined && (
          <p className={`${styles.muted} ${styles.empty}`} role="alert">
            {coordinatorChats.error ?? plans.error}
          </p>
        )}
        {loaded && rows.length === 0 && (
          <p className={`${styles.muted} ${styles.empty}`}>
            Chats with the Coordinator and the Planner appear here.
          </p>
        )}
      </div>
    </section>
  )

  let middle: ReactNode
  if (shown === undefined) {
    middle = <section className={views.pane} aria-label="Agents" />
  } else if (shown === 'start') {
    middle = (
      <StartPage
        factory={factory}
        onCoordinator={() => onOpenChat({ agent: 'coordinator', id: newCoordinatorChat })}
        onPlanner={onNewPlan}
      />
    )
  } else if (shown === 'new-coordinator') {
    middle = (
      <CoordinatorStart
        factory={factory}
        onStarted={(id) => onOpenChat({ agent: 'coordinator', id })}
        onOpenTask={onOpenTask}
      />
    )
  } else if (shown === 'new-plan' || shown.agent === 'planner') {
    const id = shown === 'new-plan' ? undefined : shown.id
    middle = (
      <PlanChatView
        key={id ?? newPlan}
        factory={factory}
        planId={id}
        revealRequest={revealRequest}
        {...(planFrom !== undefined && { from: planFrom })}
        onOpenPlan={(opened) => onOpenChat({ agent: 'planner', id: opened })}
        onPlanMore={onPlanMore}
        onOpenTask={onOpenTask}
        onDeleted={startPage}
      />
    )
  } else {
    const id = shown.id
    middle = (
      <CoordinatorChat
        key={id}
        chatId={id}
        factoryName={factory.name}
        busy={busy}
        error={error}
        onOpenTask={onOpenTask}
        onContinue={() => continueChat(id)}
        onDelete={() => {
          const summary = coordinatorSummary(id)
          if (summary) setDeleting(summary)
        }}
      />
    )
  }

  return (
    <>
      {list}
      {deleting && (
        <DeleteCoordinatorChat
          chat={deleting}
          busy={busy}
          error={error}
          onCancel={() => setDeleting(undefined)}
          onDelete={async () => {
            if (await act(() => ted.deleteCoordinatorChat(deleting.id))) {
              if (openRef?.agent === 'coordinator' && openRef.id === deleting.id) startPage()
              setDeleting(undefined)
            }
          }}
        />
      )}
      {middle}
    </>
  )
}

function ChatRow({
  row,
  current,
  onOpen,
  onMenu,
}: {
  row: AgentChatRow
  current: boolean
  onOpen: () => void
  onMenu?: (at: MenuPosition) => void
}) {
  return (
    <ActionButton
      type="button"
      data-nav-item
      className={styles.row}
      {...(current && { 'aria-current': 'true' as const })}
      {...(onMenu && contextMenu(onMenu))}
      onClick={onOpen}
    >
      <span className={styles.rowTop}>
        {row.waiting && <span className={styles.waiting} role="img" aria-label="Waiting for you" />}
        <span className={styles.agent}>{row.agent}</span>
        <span className={styles.spacer} />
        {row.lastAt && <span>{when(row.lastAt)}</span>}
      </span>
      <span className={styles.rowTitle}>{row.title}</span>
      <span className={styles.rowMeta}>
        <StatusChip tone={row.chip.tone} {...(row.chip.glyph && { glyph: row.chip.glyph })}>
          {row.chip.label}
        </StatusChip>
        <span>{row.meta}</span>
      </span>
    </ActionButton>
  )
}

function StartPage({
  factory,
  onCoordinator,
  onPlanner,
}: {
  factory: Factory
  onCoordinator: () => void
  onPlanner: () => void
}) {
  return (
    <>
      <section className={views.pane} aria-label="New chat">
        <div className={styles.start}>
          <h2>Start a chat in {factory.name}</h2>
          <p className={styles.muted}>
            Each chat is its own conversation, and your other chats keep running.
          </p>
          <div className={styles.choices}>
            <ActionButton type="button" className={styles.choice} onClick={onCoordinator}>
              <AgentAbout agent="Coordinator" />
            </ActionButton>
            <ActionButton
              type="button"
              className={styles.choice}
              disabled={!factory.cloned}
              onClick={onPlanner}
            >
              <AgentAbout agent="Planner" />
            </ActionButton>
          </div>
        </div>
      </section>
      <DetailsPane className={views.detailsPane} aria-label="Agents">
        <section className={styles.section}>
          <h2>Agents</h2>
          <p className={styles.muted}>
            An Agent helps with this Factory outside any one Task. Pick one to start a chat.
          </p>
        </section>
      </DetailsPane>
    </>
  )
}
