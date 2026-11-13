import type {
  Coordinator,
  CoordinatorConfirmation,
  CoordinatorConversationSummary,
  CoordinatorReceipt,
  Factory,
  MessageBox,
  Task,
  TaskLead,
} from '@ted/protocol'
import { useEffect, useState } from 'react'
import { ActionButton } from '../components/ActionButton.tsx'
import dialogs from '../components/ArchiveDialogs.module.css'
import { Dialog } from '../components/ArchiveDialogs.tsx'
import { Button } from '../components/Button.tsx'
import { ConfirmationCard } from '../components/ConfirmationCard.tsx'
import { EventLine } from '../components/EventLine.tsx'
import { DetailsPane } from '../components/ResizableSidebar.tsx'
import { ChatSection, Composer, runMeta } from '../components/RunChat.tsx'
import { StatusChip, type StatusGlyph, type StatusTone } from '../components/StatusChip.tsx'
import { statusLabel } from '../components/TaskStatus.tsx'
import {
  useCoordinatorChatState,
  useCoordinatorConversationChatState,
  useCoordinatorConversationState,
  useCoordinatorConversations,
  useCoordinatorState,
} from '../data.ts'
import { useMessageDraft } from '../message-drafts.ts'
import { when } from '../plans.ts'
import { readableError, ted } from '../ted.ts'
import styles from './Coordinator.module.css'
import { LeadSelects } from './PlanChat.tsx'
import views from './views.module.css'

export const coordinatorStatus: Record<
  Coordinator['status'],
  { label: string; tone: StatusTone; glyph?: StatusGlyph }
> = {
  ready: { label: 'Ready', tone: 'neutral' },
  queued: { label: 'Queued', tone: 'neutral', glyph: 'queued' },
  working: { label: 'Working', tone: 'working', glyph: 'working' },
  paused: { label: 'Paused', tone: 'neutral', glyph: 'paused' },
  failed: { label: 'Failed', tone: 'failed', glyph: 'failed' },
}

const placeholder = 'Ask about Tasks, or say what to start next…'
const help =
  'Goes to this Factory’s Coordinator. While it works, your message waits for its next step.'

export function CoordinatorView({
  factory,
  onOpenTask,
}: {
  factory: Factory
  onOpenTask: (id: string) => void
}) {
  const resource = useCoordinatorState(factory.id)
  const coordinator = resource.value
  const chatResource = useCoordinatorChatState(factory.id, coordinator?.runIds ?? [])
  const chat = chatResource.value
  const box: MessageBox = { kind: 'coordinator', id: factory.id }
  const { setText } = useMessageDraft(box)
  const [lead, setLead] = useState<TaskLead>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [resetting, setResetting] = useState(false)
  const [shown, setShown] = useState<string>()
  const [deleting, setDeleting] = useState<CoordinatorConversationSummary>()
  const earlier = useCoordinatorConversations(factory.id)
  const opened = earlier.value?.find((c) => c.id === shown)
  useEffect(() => {
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
  }, [factory.id])
  const retry = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await ted.retryCoordinator(factory.id)
    } catch (failed) {
      setError(readableError(failed))
    } finally {
      setBusy(false)
    }
  }
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
  const reset = async () => {
    if (await act(() => ted.resetCoordinator(factory.id))) {
      setResetting(false)
      setShown(undefined)
    }
  }
  const status = coordinator?.status ?? 'ready'
  const busyNow = status === 'working' || status === 'queued' || status === 'paused'
  const startNew = () => {
    if (!coordinator) setShown(undefined)
    else if (busyNow) setResetting(true)
    else void reset()
  }
  const chip = coordinatorStatus[status]
  const list = (
    <section
      className={`${views.pane} ${views.listPane}`}
      aria-label="Coordinator conversations"
      data-fixed-pane
    >
      <header className={styles.listHeader}>
        <h1 className={views.listTitle}>Coordinator</h1>
        <span className={styles.spacer} />
        <Button
          variant="primary"
          disabled={busy || (!coordinator && shown === undefined)}
          onClick={startNew}
        >
          New conversation
        </Button>
      </header>
      <div className={styles.rows}>
        {coordinator && (
          <>
            <h2 className={styles.group}>Current</h2>
            <ConversationRow
              title={coordinator.opening}
              at={coordinator.startedAt}
              taskCount={coordinator.tasks.length}
              current={shown === undefined}
              chip={chip}
              onOpen={() => setShown(undefined)}
            />
          </>
        )}
        {(earlier.value?.length ?? 0) > 0 && <h2 className={styles.group}>Earlier</h2>}
        {earlier.value?.map((c) => (
          <ConversationRow
            key={c.id}
            title={c.title}
            at={c.startedAt}
            taskCount={c.taskCount}
            current={shown === c.id}
            onOpen={() => setShown(c.id)}
          />
        ))}
        {!coordinator && earlier.value?.length === 0 && (
          <p className={`${styles.muted} ${styles.empty}`}>
            Conversations appear here once you send a message.
          </p>
        )}
      </div>
    </section>
  )
  const resetDialog = resetting && (
    <Dialog onClose={() => !busy && setResetting(false)}>
      {(headingId) => (
        <>
          <h2 id={headingId} className={dialogs.heading}>
            Stop the Coordinator and start a new conversation?
          </h2>
          <p className={dialogs.body}>
            The Coordinator stops its current reply, and messages it hasn’t read are dropped. This
            conversation is saved under Earlier, so you can open or continue it later.
          </p>
          {error !== undefined && (
            <p className={dialogs.error} role="alert">
              {error}
            </p>
          )}
          <div className={dialogs.buttons}>
            <Button disabled={busy} onClick={() => setResetting(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => reset()}>
              Stop and start new
            </Button>
          </div>
        </>
      )}
    </Dialog>
  )
  const deleteDialog = deleting && (
    <Dialog onClose={() => !busy && setDeleting(undefined)}>
      {(headingId) => (
        <>
          <h2 id={headingId} className={dialogs.heading}>
            Delete this conversation?
          </h2>
          <p className={dialogs.body}>
            {`“${deleting.title}” and its messages are deleted for good. Tasks stay as they are, and so does everything the Coordinator already did to them.`}
          </p>
          {error !== undefined && (
            <p className={dialogs.error} role="alert">
              {error}
            </p>
          )}
          <div className={dialogs.buttons}>
            <Button disabled={busy} onClick={() => setDeleting(undefined)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={async () => {
                if (await act(() => ted.deleteCoordinatorConversation(factory.id, deleting.id))) {
                  if (shown === deleting.id) setShown(undefined)
                  setDeleting(undefined)
                }
              }}
            >
              Delete
            </Button>
          </div>
        </>
      )}
    </Dialog>
  )
  if (opened)
    return (
      <>
        {list}
        <EarlierConversation
          key={opened.id}
          factoryId={factory.id}
          factoryName={factory.name}
          summary={opened}
          busy={busy}
          error={error}
          onOpenTask={onOpenTask}
          onDelete={() => setDeleting(opened)}
          onContinue={async () => {
            if (await act(() => ted.continueCoordinatorConversation(factory.id, opened.id)))
              setShown(undefined)
          }}
        />
        {deleteDialog}
        {resetDialog}
      </>
    )
  return (
    <>
      {list}
      {deleteDialog}
      {resetDialog}
      <section className={views.pane} aria-label="Coordinator">
        <header className={styles.header}>
          <div className={styles.titleRow}>
            <h1>{coordinator ? 'Current conversation' : 'New conversation'}</h1>
            {coordinator === null && lead && <LeadSelects lead={lead} onChange={setLead} />}
            {coordinator && (
              <StatusChip tone={chip.tone} {...(chip.glyph && { glyph: chip.glyph })}>
                {chip.label}
              </StatusChip>
            )}
            {status === 'failed' && (
              <Button disabled={busy} onClick={() => retry()}>
                Retry
              </Button>
            )}
          </div>
          <p>
            {[
              factory.name,
              ...(coordinator?.startedAt ? [`Started ${when(coordinator.startedAt)}`] : []),
              ...(coordinator && chat ? [runMeta(chat.run)] : []),
            ].join(' · ')}
          </p>
          {(error ?? coordinator?.error) && <p role="alert">{error ?? coordinator?.error}</p>}
        </header>
        {coordinator === null ? (
          <>
            <div className={styles.intro}>
              <h2>What needs your attention in {factory.name}?</h2>
              <p>
                I can compare Tasks, recommend next work, and start or reorder Tasks when you ask.
              </p>
              <Button onClick={() => setText('What should we work on next?')}>
                What should we work on next?
              </Button>
            </div>
            <Composer
              live
              working={false}
              label="Message to the Coordinator"
              placeholder={placeholder}
              endedPlaceholder={placeholder}
              help={help}
              interrupt={false}
              box={box}
              send={(message) => ted.messageCoordinator(factory.id, { text: message, ...lead })}
              stopTurn={() => ted.stopCoordinator(factory.id)}
            />
          </>
        ) : (
          <ChatSection
            chat={coordinator === undefined ? undefined : (chat ?? undefined)}
            loading="Loading the Coordinator…"
            error={resource.error ?? chatResource.error}
            retry={resource.error ? resource.retry : chatResource.retry}
            options={{
              bar: false,
              extra: chatExtras(
                factory.id,
                coordinator?.confirmations ?? [],
                coordinator?.receipts ?? [],
                coordinator?.tasks ?? [],
                onOpenTask,
              ),
              spot: `coordinator:${factory.id}`,
              audience: 'to the Coordinator',
              humanAs: 'comment',
              tedAs: 'line',
              label: 'Message to the Coordinator',
              placeholder,
              endedPlaceholder: 'Retry the Coordinator to send a message.',
              help,
              live: status !== 'failed',
              working: status === 'working' || status === 'queued' || status === 'paused',
              interrupt: false,
              box,
              send: (message) => ted.messageCoordinator(factory.id, { text: message }),
              stopTurn: () => ted.stopCoordinator(factory.id),
            }}
          />
        )}
      </section>
      <CoordinatorDetails tasks={coordinator?.tasks ?? []} onOpenTask={onOpenTask} />
    </>
  )
}

function ConversationRow({
  title,
  at,
  taskCount,
  current,
  chip,
  onOpen,
}: {
  title: string
  at: string
  taskCount: number
  current: boolean
  chip?: { label: string; tone: StatusTone; glyph?: StatusGlyph }
  onOpen: () => void
}) {
  return (
    <ActionButton
      type="button"
      data-nav-item
      className={styles.row}
      {...(current && { 'aria-current': 'true' as const })}
      onClick={onOpen}
    >
      <span className={styles.rowTop}>
        {chip && (
          <StatusChip tone={chip.tone} {...(chip.glyph && { glyph: chip.glyph })}>
            {chip.label}
          </StatusChip>
        )}
        {at && <span>{when(at)}</span>}
      </span>
      <span className={styles.rowTitle}>{title}</span>
      <span className={styles.rowMeta}>{taskCount === 1 ? '1 Task' : `${taskCount} Tasks`}</span>
    </ActionButton>
  )
}

function EarlierConversation({
  factoryId,
  factoryName,
  summary,
  busy,
  error,
  onOpenTask,
  onDelete,
  onContinue,
}: {
  factoryId: string
  factoryName: string
  summary: CoordinatorConversationSummary
  busy: boolean
  error: string | undefined
  onOpenTask: (id: string) => void
  onDelete: () => void
  onContinue: () => void
}) {
  const conversation = useCoordinatorConversationState(factoryId, summary.id)
  const chat = useCoordinatorConversationChatState(factoryId, summary.id)
  return (
    <>
      <section className={views.pane} aria-label="Earlier Coordinator conversation">
        <header className={styles.header}>
          <div className={styles.titleRow}>
            <h1 className={styles.earlierTitle}>{summary.title}</h1>
          </div>
          <p>
            {[
              factoryName,
              `${when(summary.startedAt || summary.endedAt)} to ${when(summary.endedAt)}`,
              ...(chat.value ? [runMeta(chat.value.run)] : []),
            ].join(' · ')}
          </p>
        </header>
        <div className={styles.banner}>
          <span>
            This is an earlier conversation. Continue it to talk to the Coordinator here again; the
            current one is saved.
          </span>
          <span className={styles.spacer} />
          <Button disabled={busy} onClick={onDelete}>
            Delete
          </Button>
          <Button variant="primary" disabled={busy} onClick={onContinue}>
            Continue
          </Button>
        </div>
        {error !== undefined && (
          <p className={styles.bannerError} role="alert">
            {error}
          </p>
        )}
        <ChatSection
          chat={chat.value}
          loading="Loading the conversation…"
          error={chat.error ?? conversation.error}
          retry={chat.error ? chat.retry : conversation.retry}
          options={{
            bar: false,
            extra: chatExtras(
              factoryId,
              conversation.value?.confirmations ?? [],
              conversation.value?.receipts ?? [],
              conversation.value?.tasks ?? [],
              onOpenTask,
            ),
            spot: `coordinator-conversation:${summary.id}`,
            audience: 'to the Coordinator',
            humanAs: 'comment',
            tedAs: 'line',
            readOnly: (
              <p className={`${styles.muted} ${styles.readOnly}`}>
                Read only. Continue this conversation to send a message.
              </p>
            ),
          }}
        />
      </section>
      <CoordinatorDetails tasks={conversation.value?.tasks ?? []} onOpenTask={onOpenTask} />
    </>
  )
}

function chatExtras(
  factoryId: string,
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
          factoryId={factoryId}
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
  tasks,
  onOpenTask,
}: {
  tasks: readonly Task[]
  onOpenTask: (id: string) => void
}) {
  return (
    <DetailsPane className={views.detailsPane} aria-label="Coordinator details">
      <section className={styles.section}>
        <h2>Tasks in this conversation</h2>
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
        <p>
          Compare Tasks, decide what matters, then ask the Coordinator to start or reorder work.
          Each Task keeps its own Task Lead.
        </p>
        <p className={styles.muted}>Starts enter Intake as Queued and wait for a free Run slot.</p>
        <p className={styles.muted}>
          New conversation saves the current one under Earlier. Earlier conversations stay until you
          delete them.
        </p>
      </section>
    </DetailsPane>
  )
}
