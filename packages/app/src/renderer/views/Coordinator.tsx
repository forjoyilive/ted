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
import { useEffect, useRef, useState } from 'react'
import { type ChatState, coordinatorChatState, coordinatorStatus } from '../agent-chats.ts'
import { ActionButton } from '../components/ActionButton.tsx'
import { builtInCoordinator, removedAgentNote } from '../components/AgentAbout.tsx'
import {
  AgentChat,
  AgentChatDetails,
  type ChatControls,
  DetailText,
  ReadOnlyNote,
} from '../components/AgentChat.tsx'
import { AutomationCard } from '../components/AutomationCard.tsx'
import { Button } from '../components/Button.tsx'
import { ConfirmationCard } from '../components/ConfirmationCard.tsx'
import { EventLine } from '../components/EventLine.tsx'
import { PiAutoNote } from '../components/PiAutoNote.tsx'
import { ChatSection, Composer, runMeta, tokenAmount } from '../components/RunChat.tsx'
import { agentNames } from '../components/RunIcon.tsx'
import { statusLabel } from '../components/TaskStatus.tsx'
import { useCoordinatorChatState, useCoordinatorState } from '../data.ts'
import { useMessageDraft } from '../message-drafts.ts'
import { when } from '../plans.ts'
import { ted } from '../ted.ts'
import { AgentDescriptionLine, AgentHeading } from './AgentPicker.tsx'
import styles from './Coordinator.module.css'
import { Back, chatRequestItems, LeadSelects } from './PlanChat.tsx'
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
  onBack,
  onStarted,
  onOpenTask,
}: {
  factory: Factory
  agent: AgentSummary
  onBack?: () => void
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
            {onBack && <Back onBack={onBack} label="← All agents" />}
            <AgentHeading agent={agent} />
            {lead && <LeadSelects lead={lead} onChange={setLead} />}
          </div>
          {lead && <PiAutoNote agent={lead.agent} factoryId={factory.id} alwaysAuto />}
          <AgentDescriptionLine agent={agent} />
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
      <AgentChatDetails
        label={`${agent.name} details`}
        agent={agent}
        factoryId={factory.id}
        provider={
          lead && [agentNames[lead.agent], lead.model, lead.effort].filter(Boolean).join(' · ')
        }
        startedFrom={<DetailText>Chat, by you</DetailText>}
        tasks={
          agent.powers.includes('manage_tasks')
            ? {
                title: 'Tasks in this chat',
                body: <TasksInChat tasks={[]} onOpenTask={onOpenTask} />,
              }
            : undefined
        }
      />
    </>
  )
}

export function CoordinatorChat({
  chatId,
  factoryName,
  controls,
  onOpenTask,
  onOpenAutomation,
}: {
  chatId: string
  factoryName: string
  controls: (state: ChatState) => ChatControls
  onOpenTask: (id: string) => void
  onOpenAutomation: (id: string) => void
}) {
  const resource = useCoordinatorState(chatId)
  const coordinator = resource.value
  const chatResource = useCoordinatorChatState(chatId, coordinator?.runIds ?? [])
  const chat = chatResource.value
  const box: MessageBox = { kind: 'coordinator', id: chatId }
  const agent: ChatAgent = coordinator?.chatAgent ?? { ...builtInCoordinator, removed: false }
  const removed = agent.removed
  const { placeholder, help, label, audience } = texts(agent)
  const status = coordinator?.status ?? 'ready'
  const state = coordinatorChatState({
    id: chatId,
    status,
    chatAgent: agent,
    ...(coordinator?.endedAt !== undefined && { endedAt: coordinator.endedAt }),
  })
  const ended = state.archived
  const run = chat?.run
  const provider = run
    ? [agentNames[run.agent], run.model, run.effort].filter(Boolean).join(' · ')
    : undefined
  return (
    <AgentChat
      label={agent.name}
      title={coordinator ? coordinator.title || `${agent.name} chat` : 'Chat'}
      onRename={(title) => ted.renameCoordinatorChat(chatId, title)}
      chip={ended ? archivedChip : coordinatorStatus[status]}
      meta={[
        factoryName,
        ...(coordinator?.startedAt
          ? [
              ended && coordinator.endedAt
                ? `${when(coordinator.startedAt)} to ${when(coordinator.endedAt)}`
                : `Started ${when(coordinator.startedAt)}`,
            ]
          : []),
        ...(coordinator && run ? [runMeta(run)] : []),
      ].join(' · ')}
      alert={ended ? undefined : coordinator?.error}
      banner={
        ended
          ? 'This chat is archived. Unarchive it to write to it again.'
          : state.restart !== undefined
            ? `This chat failed. Retry carries on where ${agent.name} stopped.`
            : undefined
      }
      controls={controls(state)}
      details={
        <AgentChatDetails
          label={`${agent.name} details`}
          agent={agent}
          factoryId={coordinator?.factoryId}
          removed={removed}
          provider={provider}
          startedFrom={<DetailText>Chat, by you</DetailText>}
          tasks={
            agent.powers.includes('manage_tasks')
              ? {
                  title: 'Tasks in this chat',
                  body: <TasksInChat tasks={coordinator?.tasks ?? []} onOpenTask={onOpenTask} />,
                }
              : undefined
          }
          run={
            run && {
              agent: run.agent,
              state:
                status === 'failed'
                  ? 'failed'
                  : run.state === 'working' || run.state === 'waiting'
                    ? run.state
                    : 'idle',
              name: agent.name,
              line: [provider, run.state].filter(Boolean).join(' · '),
            }
          }
          tokens={
            run?.tokens === undefined
              ? undefined
              : [run.credential, tokenAmount(run.tokens)].filter(Boolean).join(' · ')
          }
        />
      }
    >
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
          tedAs: 'line',
          ...(ended || removed
            ? {
                readOnly: (
                  <ReadOnlyNote>
                    {ended ? 'Read only. Unarchive this chat to send a message.' : removedAgentNote}
                  </ReadOnlyNote>
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
    </AgentChat>
  )
}

const archivedChip = { tone: 'neutral' as const, label: 'Archived' }

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

function TasksInChat({
  tasks,
  onOpenTask,
}: {
  tasks: readonly Task[]
  onOpenTask: (id: string) => void
}) {
  if (tasks.length === 0)
    return <DetailText muted>Tasks appear here as you discuss them.</DetailText>
  return tasks.map((task) => (
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
}
