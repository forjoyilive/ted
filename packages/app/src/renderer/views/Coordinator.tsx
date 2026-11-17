import type {
  AgentSummary,
  ChatAgent,
  CoordinatorConfirmation,
  CoordinatorReceipt,
  Factory,
  MessageBox,
  Task,
  TaskLead,
} from '@ted/protocol'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { coordinatorStatus } from '../agent-chats.ts'
import { ActionButton } from '../components/ActionButton.tsx'
import {
  AgentAbout,
  AgentCommands,
  AgentPowers,
  AgentSource,
  builtInCoordinator,
  removedAgentNote,
  shownCommands,
} from '../components/AgentAbout.tsx'
import { AutomationCard } from '../components/AutomationCard.tsx'
import { Button } from '../components/Button.tsx'
import { ConfirmationCard } from '../components/ConfirmationCard.tsx'
import { EventLine } from '../components/EventLine.tsx'
import { OutsideCommandsSection } from '../components/OutsideCommands.tsx'
import { DetailsPane } from '../components/ResizableSidebar.tsx'
import { ChatSection, Composer, runMeta } from '../components/RunChat.tsx'
import { agentNames } from '../components/RunIcon.tsx'
import { StatusChip } from '../components/StatusChip.tsx'
import { statusLabel } from '../components/TaskStatus.tsx'
import { useCoordinatorChatState, useCoordinatorState } from '../data.ts'
import { useMessageDraft } from '../message-drafts.ts'
import { when } from '../plans.ts'
import { readableError, ted } from '../ted.ts'
import styles from './Coordinator.module.css'
import { chatRequestItems, LeadSelects, TitleEditor } from './PlanChat.tsx'
import views from './views.module.css'

function isCoordinator(agent: Pick<AgentSummary, 'id' | 'source'>): boolean {
  return agent.id === 'coordinator' && agent.source === 'ted'
}

function texts(agent: Pick<AgentSummary, 'id' | 'name' | 'source'>) {
  return isCoordinator(agent)
    ? {
        placeholder: 'Ask about Tasks, or say what to start next…',
        help: 'Goes to this Coordinator chat. While it works, your message waits for its next step.',
        label: 'Message to the Coordinator',
        audience: 'to the Coordinator',
      }
    : {
        placeholder: `Message ${agent.name}…`,
        help: `Goes to this chat with ${agent.name}. While it works, your message waits for its next step.`,
        label: `Message to ${agent.name}`,
        audience: `to ${agent.name}`,
      }
}

export function CoordinatorStart({
  factory,
  agent,
  switcher,
  onStarted,
  onOpenTask,
}: {
  factory: Factory
  agent: AgentSummary
  switcher?: ReactNode
  onStarted: (id: string) => void
  onOpenTask: (id: string) => void
}) {
  const box: MessageBox = { kind: 'coordinator-new', id: factory.id }
  const { setText } = useMessageDraft(box)
  const [lead, setLead] = useState<TaskLead>()
  const { placeholder, help, label } = texts(agent)
  const agentKind = agent.agent
  const agentModel = agent.model
  const shown = useRef(true)
  useEffect(() => {
    shown.current = true
    return () => {
      shown.current = false
    }
  }, [])
  useEffect(() => {
    if (agentKind !== undefined) {
      setLead({ agent: agentKind, ...(agentModel !== undefined && { model: agentModel }) })
      return
    }
    let active = true
    void ted.taskDefaults(factory.id).then(
      (defaults) => {
        if (active) setLead(defaults.planner)
      },
      () => {
        if (active) setLead({ agent: 'claude' })
      },
    )
    return () => {
      active = false
    }
  }, [factory.id, agentKind, agentModel])
  return (
    <>
      <section className={views.pane} aria-label={agent.name}>
        <header className={styles.header}>
          <div className={styles.titleRow}>
            <h1>New chat</h1>
            {switcher}
            {lead && <LeadSelects lead={lead} onChange={setLead} />}
          </div>
          <p>{factory.name}</p>
        </header>
        {isCoordinator(agent) ? (
          <div className={styles.intro}>
            <h2>What needs your attention in {factory.name}?</h2>
            <p>
              I can compare Tasks, recommend next work, and start or reorder Tasks when you ask.
            </p>
            <Button onClick={() => setText('What should we work on next?')}>
              What should we work on next?
            </Button>
          </div>
        ) : (
          <div className={styles.intro}>
            <h2>{`New chat with ${agent.name} in ${factory.name}`}</h2>
          </div>
        )}
        <Composer
          live
          working={false}
          label={label}
          placeholder={placeholder}
          endedPlaceholder={placeholder}
          help={help}
          interrupt={false}
          box={box}
          send={async (message) => {
            const started = await ted.startCoordinatorChat(factory.id, {
              text: message,
              ...lead,
              agentId: agent.id,
            })
            if (shown.current) onStarted(started.id)
            return started
          }}
          stopTurn={async () => null}
        />
      </section>
      <CoordinatorDetails
        agent={agent}
        factoryId={factory.id}
        tasks={[]}
        provider={
          lead && [agentNames[lead.agent], lead.model, lead.effort].filter(Boolean).join(' · ')
        }
        onOpenTask={onOpenTask}
      />
    </>
  )
}

export function CoordinatorChat({
  chatId,
  factoryName,
  busy,
  error,
  onOpenTask,
  onOpenAutomation,
  onArchive,
  onUnarchive,
  onDelete,
}: {
  chatId: string
  factoryName: string
  busy: boolean
  error: string | undefined
  onOpenTask: (id: string) => void
  onOpenAutomation: (id: string) => void
  onArchive: () => void
  onUnarchive: () => void
  onDelete: () => void
}) {
  const resource = useCoordinatorState(chatId)
  const coordinator = resource.value
  const chatResource = useCoordinatorChatState(chatId, coordinator?.runIds ?? [])
  const chat = chatResource.value
  const box: MessageBox = { kind: 'coordinator', id: chatId }
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string>()
  const ended = coordinator?.endedAt !== undefined
  const agent: ChatAgent = coordinator?.chatAgent ?? { ...builtInCoordinator, removed: false }
  const removed = agent.removed
  const { placeholder, help, label, audience } = texts(agent)
  const status = coordinator?.status ?? 'ready'
  const chip = coordinatorStatus[status]
  const retry = async () => {
    setRetrying(true)
    setRetryError(undefined)
    try {
      await ted.retryCoordinator(chatId)
    } catch (failed) {
      setRetryError(readableError(failed))
    } finally {
      setRetrying(false)
    }
  }
  const shownError = error ?? retryError ?? coordinator?.error
  return (
    <>
      <section className={views.pane} aria-label={agent.name}>
        <header className={styles.header}>
          <div className={styles.titleRow}>
            {coordinator ? (
              <TitleEditor
                current={coordinator.title || `${agent.name} chat`}
                onRename={(title) => ted.renameCoordinatorChat(chatId, title)}
              />
            ) : (
              <h1 className={styles.chatTitle}>Chat</h1>
            )}
            {coordinator && !ended && (
              <StatusChip tone={chip.tone} {...(chip.glyph && { glyph: chip.glyph })}>
                {chip.label}
              </StatusChip>
            )}
            {!ended && !removed && status === 'failed' && (
              <Button disabled={retrying} onClick={() => retry()}>
                Retry
              </Button>
            )}
            {coordinator && !ended && (
              <>
                <span className={styles.spacer} />
                <Button disabled={busy} onClick={onArchive}>
                  Archive
                </Button>
              </>
            )}
          </div>
          <p>
            {[
              factoryName,
              ...(coordinator?.startedAt
                ? [
                    ended && coordinator.endedAt
                      ? `${when(coordinator.startedAt)} to ${when(coordinator.endedAt)}`
                      : `Started ${when(coordinator.startedAt)}`,
                  ]
                : []),
              ...(coordinator && chat ? [runMeta(chat.run)] : []),
            ].join(' · ')}
          </p>
          {!ended && shownError && <p role="alert">{shownError}</p>}
        </header>
        {ended && (
          <>
            <div className={styles.banner}>
              <span>This chat is archived. Unarchive it to write to it again.</span>
              <span className={styles.spacer} />
              <Button disabled={busy} onClick={onDelete}>
                Delete…
              </Button>
              <Button variant="primary" disabled={busy} onClick={onUnarchive}>
                Unarchive
              </Button>
            </div>
            {error !== undefined && (
              <p className={styles.bannerError} role="alert">
                {error}
              </p>
            )}
          </>
        )}
        <ChatSection
          chat={coordinator === undefined ? undefined : (chat ?? undefined)}
          loading="Loading the chat…"
          error={resource.error ?? chatResource.error}
          retry={resource.error ? resource.retry : chatResource.retry}
          options={{
            bar: false,
            extra: [
              ...chatExtras(
                chatId,
                coordinator?.confirmations ?? [],
                coordinator?.receipts ?? [],
                coordinator?.tasks ?? [],
                onOpenTask,
              ),
              ...(coordinator?.automationCards ?? []).map((card) => ({
                id: card.id,
                at: card.askedAt,
                node: (
                  <AutomationCard
                    key={`${card.id}:${card.answer?.decision ?? 'open'}`}
                    chatId={chatId}
                    card={card}
                    agentName={agent.name}
                    onOpenAutomation={onOpenAutomation}
                  />
                ),
              })),
              ...chatRequestItems(
                chatId,
                coordinator?.requests ?? [],
                agent.name,
                onOpenTask,
                !coordinator?.chatAgent.removed,
              ),
            ],
            spot: `coordinator:${chatId}`,
            audience,
            humanAs: 'comment',
            tedAs: 'line',
            ...(ended || removed
              ? {
                  readOnly: (
                    <p className={`${styles.muted} ${styles.readOnly}`}>
                      {ended
                        ? 'Read only. Unarchive this chat to send a message.'
                        : removedAgentNote}
                    </p>
                  ),
                }
              : {
                  label,
                  placeholder,
                  endedPlaceholder: `Retry ${agent.name} to send a message.`,
                  help,
                  live: status !== 'failed',
                  working: status === 'working' || status === 'queued' || status === 'paused',
                  interrupt: false,
                  box,
                  send: (message: string) => ted.messageCoordinator(chatId, { text: message }),
                  stopTurn: () => ted.stopCoordinator(chatId),
                  stopOutside: () => void ted.stopOutsideCommand(chatId),
                }),
          }}
        />
      </section>
      <CoordinatorDetails
        agent={agent}
        factoryId={coordinator?.factoryId}
        removed={removed}
        tasks={coordinator?.tasks ?? []}
        provider={
          chat
            ? [agentNames[chat.run.agent], chat.run.model, chat.run.effort]
                .filter(Boolean)
                .join(' · ')
            : undefined
        }
        onOpenTask={onOpenTask}
      />
    </>
  )
}

function chatExtras(
  chatId: string,
  confirmations: readonly CoordinatorConfirmation[],
  receipts: readonly CoordinatorReceipt[],
  tasks: readonly Task[],
  onOpenTask: (id: string) => void,
) {
  return [
    ...confirmations.map((confirmation) => ({
      id: confirmation.id,
      at: confirmation.askedAt,
      node: (
        <ConfirmationCard
          key={`${confirmation.id}:${confirmation.answer?.decision ?? 'open'}`}
          chatId={chatId}
          confirmation={confirmation}
        />
      ),
    })),
    ...receipts.map((receipt) => {
      const task = tasks.find((t) => t.id === receipt.taskId)
      return {
        id: receipt.id,
        at: receipt.at,
        node: (
          <ul className={styles.lines}>
            <EventLine
              tone="run"
              text={receipt.text}
              at={receipt.at}
              action={
                receipt.taskId !== undefined && (
                  <ActionButton
                    type="button"
                    className={styles.open}
                    onClick={() => receipt.taskId && onOpenTask(receipt.taskId)}
                  >
                    {task ? `Open ${task.displayId}` : 'Open Task'}
                  </ActionButton>
                )
              }
            />
          </ul>
        ),
      }
    }),
  ]
}

function CoordinatorDetails({
  agent,
  factoryId,
  removed = false,
  tasks,
  provider,
  onOpenTask,
}: {
  agent: AgentSummary
  factoryId: string | undefined
  removed?: boolean
  tasks: readonly Task[]
  provider: string | undefined
  onOpenTask: (id: string) => void
}) {
  const manages = agent.powers.includes('manage_tasks')
  return (
    <DetailsPane className={views.detailsPane} aria-label={`${agent.name} details`}>
      <section className={styles.section} aria-label="Agent">
        <h2>Agent</h2>
        <AgentAbout agent={agent} provider={provider} removed={removed} />
      </section>
      <section className={styles.section} aria-label="Powers">
        <h2>Powers</h2>
        <AgentPowers powers={agent.powers} />
      </section>
      {shownCommands(agent).length > 0 && (
        <section className={styles.section} aria-label="Commands">
          <h2>Commands</h2>
          <AgentCommands commands={shownCommands(agent)} />
        </section>
      )}
      <OutsideCommandsSection factoryId={factoryId} agent={agent} className={styles.section} />
      <section className={styles.section} aria-label="From">
        <h2>From</h2>
        <AgentSource source={agent.source} />
      </section>
      {manages && <TasksInChat tasks={tasks} onOpenTask={onOpenTask} />}
    </DetailsPane>
  )
}

function TasksInChat({
  tasks,
  onOpenTask,
}: {
  tasks: readonly Task[]
  onOpenTask: (id: string) => void
}) {
  return (
    <>
      <section className={styles.section}>
        <h2>Tasks in this chat</h2>
        {tasks.length ? (
          tasks.map((task) => (
            <ActionButton
              key={task.id}
              type="button"
              data-nav-item
              className={styles.task}
              onClick={() => onOpenTask(task.id)}
            >
              <span className={styles.meta}>
                {task.displayId} · {task.status ? statusLabel(task.status) : task.stage}
              </span>
              <span>{task.title}</span>
            </ActionButton>
          ))
        ) : (
          <p className={styles.muted}>Tasks appear here as you discuss them.</p>
        )}
      </section>
      <section className={styles.section}>
        <h2>How it works</h2>
        <p className={styles.muted}>Starts enter Intake as Queued and wait for a free Run slot.</p>
        <p className={styles.muted}>
          Each chat runs on its own, so a new chat leaves your other chats running. Chats stay until
          you delete them.
        </p>
      </section>
    </>
  )
}
