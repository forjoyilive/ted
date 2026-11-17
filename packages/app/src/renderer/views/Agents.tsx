import type { AgentSummary, Factory } from '@ted/protocol'
import { type ReactNode, useEffect, useState } from 'react'
import {
  type AgentChatRef,
  type AgentChatRow,
  agentChatRows,
  groupedRows,
  pickChat,
  sameChat,
  splitArchived,
  useAgentsView,
} from '../agent-chats.ts'
import { ActionButton } from '../components/ActionButton.tsx'
import { agentLine, builtInCoordinator, builtInPlanner } from '../components/AgentAbout.tsx'
import dialogs from '../components/ArchiveDialogs.module.css'
import { Dialog } from '../components/ArchiveDialogs.tsx'
import { Button } from '../components/Button.tsx'
import { contextMenu, type MenuPosition, useActionMenu } from '../components/ContextMenu.tsx'
import type { ScrollReveal } from '../components/ScrollMemory.tsx'
import { Select } from '../components/Select.tsx'
import { StatusChip } from '../components/StatusChip.tsx'
import { useCoordinatorChats, useFactoryAgents, usePlansState } from '../data.ts'
import { useMessageDraft } from '../message-drafts.ts'
import { newPlan } from '../navigation.ts'
import { when } from '../plans.ts'
import { readableError, ted } from '../ted.ts'
import styles from './Agents.module.css'
import { CoordinatorChat, CoordinatorStart } from './Coordinator.tsx'
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
  const [deleting, setDeleting] = useState<AgentChatRow>()
  const [archivedOpen, setArchivedOpen] = useState(false)
  const rowMenu = useActionMenu('agent-chats')
  const agents = orderedAgents(useFactoryAgents(factory.id).value)
  const [newAgentId, setNewAgentId] = useState(builtInCoordinator.id)

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
  useEffect(() => {
    if (openAgent !== undefined) setNewAgentId(builtInCoordinator.id)
  }, [openAgent])

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
  const archive = (ref: AgentChatRef) =>
    act(() =>
      ref.agent === 'coordinator' ? ted.archiveCoordinatorChat(ref.id) : ted.archivePlan(ref.id),
    )
  const unarchive = (ref: AgentChatRef) =>
    act(() =>
      ref.agent === 'coordinator'
        ? ted.unarchiveCoordinatorChat(ref.id)
        : ted.unarchivePlan(ref.id),
    )
  const startPage = () => onOpenChat({ agent: 'coordinator', id: agentsStart })
  const rowOf = (ref: AgentChatRef) => rows.find((r) => sameChat(r.ref, ref))
  const askDelete = (ref: AgentChatRef) => {
    const row = rowOf(ref)
    if (row) setDeleting(row)
  }
  const { open: openRows, archived: archivedRows } = splitArchived(rows)
  const openArchived = archivedRows.some((r) => sameChat(r.ref, openRef))
  useEffect(() => {
    if (openArchived) setArchivedOpen(true)
  }, [openArchived])
  const showArchived = archivedOpen || openArchived

  const rowFor = (row: AgentChatRow) => {
    const ref = row.ref
    const archived = row.archivedAt !== undefined
    return (
      <ChatRow
        key={`${ref.agent}:${ref.id}`}
        row={row}
        current={openRef?.agent === ref.agent && openRef.id === ref.id}
        onOpen={() => onOpenChat(ref)}
        onMenu={(at: MenuPosition) =>
          rowMenu.open(at, archived ? 'Archived chat' : 'Chat', [
            archived
              ? { label: 'Unarchive', disabled: busy, action: () => void unarchive(ref) }
              : { label: 'Archive', disabled: busy, action: () => void archive(ref) },
            {
              label: 'Delete…',
              danger: true,
              disabled: busy,
              action: () => setDeleting(row),
            },
          ])
        }
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
          ? groupedRows(openRows).map((group) => (
              <section key={group.agent} aria-label={`${group.agent} chats`}>
                <h2 className={styles.group}>
                  {group.agent} · {group.rows.length}
                </h2>
                {group.rows.map(rowFor)}
              </section>
            ))
          : openRows.map(rowFor)}
        {archivedRows.length > 0 && (
          <section aria-label="Archived chats">
            <button
              type="button"
              className={styles.archivedToggle}
              aria-expanded={showArchived}
              onClick={() => setArchivedOpen(!showArchived)}
            >
              <span aria-hidden="true">{showArchived ? '▾' : '▸'}</span>
              Archived · {archivedRows.length}
            </button>
            {showArchived && archivedRows.map(rowFor)}
          </section>
        )}
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

  const chosen = agents.find((a) => a.id === newAgentId && a.id !== 'planner') ?? builtInCoordinator
  const planner = agents.find((a) => a.id === 'planner')
  const switcher = (current: AgentSummary) => (
    <AgentSwitch
      factory={factory}
      agents={agents}
      current={current}
      onPick={(next) => {
        if (next.id === 'planner') return onNewPlan()
        setNewAgentId(next.id)
        if (current.id === 'planner') onOpenChat({ agent: 'coordinator', id: newCoordinatorChat })
      }}
    />
  )
  let middle: ReactNode
  if (shown === undefined) {
    middle = <section className={views.pane} aria-label="Agents" />
  } else if (shown === 'start' || shown === 'new-coordinator') {
    middle = (
      <CoordinatorStart
        key={chosen.id}
        factory={factory}
        agent={chosen}
        switcher={switcher(chosen)}
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
        agent={planner}
        {...(id === undefined &&
          planFrom === undefined && { switcher: switcher(planner ?? builtInPlanner) })}
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
        onArchive={() => void archive({ agent: 'coordinator', id })}
        onUnarchive={() => void unarchive({ agent: 'coordinator', id })}
        onDelete={() => askDelete({ agent: 'coordinator', id })}
      />
    )
  }

  return (
    <>
      {list}
      {deleting && (
        <DeleteChat
          row={deleting}
          busy={busy}
          error={error}
          onCancel={() => setDeleting(undefined)}
          onDelete={async () => {
            const ref = deleting.ref
            const deleted = await act(() =>
              ref.agent === 'coordinator'
                ? ted.deleteCoordinatorChat(ref.id)
                : ted.deletePlan(ref.id),
            )
            if (deleted) {
              if (sameChat(openRef, ref)) startPage()
              setDeleting(undefined)
            }
          }}
        />
      )}
      {middle}
    </>
  )
}

function DeleteChat({
  row,
  busy,
  error,
  onCancel,
  onDelete,
}: {
  row: AgentChatRow
  busy: boolean
  error: string | undefined
  onCancel: () => void
  onDelete: () => void
}) {
  const live = row.archivedAt === undefined
  const who = row.agent === 'Coordinator' ? 'the Coordinator' : row.agent
  const body =
    row.ref.agent === 'coordinator'
      ? `${live ? `${who.charAt(0).toUpperCase()}${who.slice(1)} stops this chat’s reply and its open confirmation cards are canceled. ` : ''}“${row.title}” and its messages are deleted for good. Tasks stay as they are, and so does everything ${who} already did to them.`
      : `${live ? 'The Planner stops and its open questions are withdrawn. ' : ''}“${row.title}” and its conversation are deleted for good. Tasks it created stay.`
  return (
    <Dialog onClose={() => !busy && onCancel()}>
      {(headingId) => (
        <>
          <h2 id={headingId} className={dialogs.heading}>
            Delete this chat?
          </h2>
          <p className={dialogs.body}>{body}</p>
          {error !== undefined && (
            <p className={dialogs.error} role="alert">
              {error}
            </p>
          )}
          <div className={dialogs.buttons}>
            <Button disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="danger" disabled={busy} onClick={onDelete}>
              Delete
            </Button>
          </div>
        </>
      )}
    </Dialog>
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
  onMenu: (at: MenuPosition) => void
}) {
  return (
    <ActionButton
      type="button"
      data-nav-item
      className={styles.row}
      {...(current && { 'aria-current': 'true' as const })}
      {...contextMenu(onMenu)}
      onClick={onOpen}
    >
      <span className={styles.rowTop}>
        {row.waiting && <span className={styles.waiting} role="img" aria-label="Waiting for you" />}
        <span className={styles.agent}>{row.agent}</span>
        <span className={styles.spacer} />
        {row.archivedAt !== undefined ? (
          <span>Archived {when(row.archivedAt)}</span>
        ) : (
          row.lastAt && <span>{when(row.lastAt)}</span>
        )}
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

const builtInOrder = [builtInCoordinator.id, builtInPlanner.id]

function orderedAgents(agents: readonly AgentSummary[] | undefined): AgentSummary[] {
  const all = agents ?? [builtInCoordinator, builtInPlanner]
  const place = (agent: AgentSummary) => {
    const at = builtInOrder.indexOf(agent.id)
    return at === -1 ? builtInOrder.length : at
  }
  return [...all].sort((a, b) => place(a) - place(b) || a.name.localeCompare(b.name))
}

function AgentSwitch({
  factory,
  agents,
  current,
  onPick,
}: {
  factory: Factory
  agents: readonly AgentSummary[]
  current: AgentSummary
  onPick: (agent: AgentSummary) => void
}) {
  const coordinator = useMessageDraft({ kind: 'coordinator-new', id: factory.id })
  const planner = useMessageDraft({ kind: 'new-plan', id: factory.id })
  const pick = (id: string) => {
    const next = agents.find((a) => a.id === id)
    if (!next || next.id === current.id) return
    if ((next.id === 'planner') !== (current.id === 'planner')) {
      const [from, to] = current.id === 'planner' ? [planner, coordinator] : [coordinator, planner]
      if (from.text.trim() !== '') {
        to.setText(from.text)
        from.clear()
      }
    }
    onPick(next)
  }
  const shown = agents.some((a) => a.id === current.id) ? agents : [current, ...agents]
  return (
    <span className={styles.agentPick}>
      <Select aria-label="Agent" value={current.id} onChange={(event) => pick(event.target.value)}>
        {shown.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.name}
          </option>
        ))}
      </Select>
      <span className={styles.agentLine}>{agentLine(current)}</span>
    </span>
  )
}
