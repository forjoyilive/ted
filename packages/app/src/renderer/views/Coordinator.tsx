import type {
  Coordinator,
  CoordinatorChatSummary,
  CoordinatorConfirmation,
  CoordinatorReceipt,
  Factory,
  MessageBox,
  Task,
  TaskLead,
} from '@ted/protocol'
import { useEffect, useRef, useState } from 'react'
import { ActionButton } from '../components/ActionButton.tsx'
import dialogs from '../components/ArchiveDialogs.module.css'
import { Dialog } from '../components/ArchiveDialogs.tsx'
import { Button } from '../components/Button.tsx'
import { ConfirmationCard } from '../components/ConfirmationCard.tsx'
import { contextMenu, type MenuPosition, useActionMenu } from '../components/ContextMenu.tsx'
import { EventLine } from '../components/EventLine.tsx'
import { DetailsPane } from '../components/ResizableSidebar.tsx'
import { ChatSection, Composer, runMeta } from '../components/RunChat.tsx'
import { StatusChip, type StatusGlyph, type StatusTone } from '../components/StatusChip.tsx'
import { statusLabel } from '../components/TaskStatus.tsx'
import { useCoordinatorChatState, useCoordinatorChats, useCoordinatorState } from '../data.ts'
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
  chatId,
  onOpenTask,
}: {
  factory: Factory
  chatId?: string | undefined
  onOpenTask: (id: string) => void
}) {
  const chats = useCoordinatorChats(factory.id)
  const [shown, setShown] = useState<string | null | undefined>(chatId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [deleting, setDeleting] = useState<CoordinatorChatSummary>()
  const rowMenu = useActionMenu('coordinator-chats')
  useEffect(() => {
    if (chatId !== undefined) setShown(chatId)
  }, [chatId])
  const newest = chats.value?.find((c) => c.endedAt === undefined)
  const openId = shown === null ? undefined : (shown ?? newest?.id)
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
    if (await act(() => ted.continueCoordinatorChat(id))) setShown(id)
  }
  const list = (
    <section
      className={`${views.pane} ${views.listPane}`}
      aria-label="Coordinator chats"
      data-fixed-pane
    >
      <header className={styles.listHeader}>
        <h1 className={views.listTitle}>Coordinator</h1>
        <span className={styles.spacer} />
        <Button variant="primary" disabled={busy} onClick={() => setShown(null)}>
          New chat
        </Button>
      </header>
      {rowMenu.menu}
      <div className={styles.rows}>
        {chats.value?.map((c) => (
          <ChatRow
            key={c.id}
            chat={c}
            current={openId === c.id}
            onOpen={() => setShown(c.id)}
            onMenu={(at) =>
              rowMenu.open(at, c.endedAt === undefined ? 'Chat' : 'Ended chat', [
                ...(c.endedAt !== undefined
                  ? [{ label: 'Continue', disabled: busy, action: () => continueChat(c.id) }]
                  : []),
                { label: 'Delete…', danger: true, disabled: busy, action: () => setDeleting(c) },
              ])
            }
          />
        ))}
        {chats.value?.length === 0 && (
          <p className={`${styles.muted} ${styles.empty}`}>
            Chats appear here once you send a message.
          </p>
        )}
      </div>
    </section>
  )
  const deleteDialog = deleting && (
    <Dialog onClose={() => !busy && setDeleting(undefined)}>
      {(headingId) => (
        <>
          <h2 id={headingId} className={dialogs.heading}>
            Delete this chat?
          </h2>
          <p className={dialogs.body}>
            {deleting.endedAt === undefined
              ? `The Coordinator stops this chat’s reply and its open confirmation cards are canceled. “${deleting.title}” and its messages are then deleted for good. Tasks stay as they are, and so does everything the Coordinator already did to them. Your other chats aren’t affected.`
              : `“${deleting.title}” and its messages are deleted for good. Tasks stay as they are, and so does everything the Coordinator already did to them.`}
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
                if (await act(() => ted.deleteCoordinatorChat(deleting.id))) {
                  if (openId === deleting.id) setShown(undefined)
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
  return (
    <>
      {list}
      {deleteDialog}
      {openId === undefined ? (
        chats.value === undefined && shown !== null ? (
          <section className={views.pane} aria-label="Coordinator" />
        ) : (
          <NewChat factory={factory} onStarted={setShown} onOpenTask={onOpenTask} />
        )
      ) : (
        <ChatPane
          key={openId}
          chatId={openId}
          factoryName={factory.name}
          busy={busy}
          error={error}
          onOpenTask={onOpenTask}
          onContinue={() => continueChat(openId)}
          onDelete={() => {
            const summary = chats.value?.find((c) => c.id === openId)
            if (summary) setDeleting(summary)
          }}
        />
      )}
    </>
  )
}

function NewChat({
  factory,
  onStarted,
  onOpenTask,
}: {
  factory: Factory
  onStarted: (id: string) => void
  onOpenTask: (id: string) => void
}) {
  const box: MessageBox = { kind: 'coordinator-new', id: factory.id }
  const { setText } = useMessageDraft(box)
  const [lead, setLead] = useState<TaskLead>()
  const shown = useRef(true)
  useEffect(() => {
    shown.current = true
    return () => {
      shown.current = false
    }
  }, [])
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
  return (
    <>
      <section className={views.pane} aria-label="Coordinator">
        <header className={styles.header}>
          <div className={styles.titleRow}>
            <h1>New chat</h1>
            {lead && <LeadSelects lead={lead} onChange={setLead} />}
          </div>
          <p>{factory.name}</p>
        </header>
        <div className={styles.intro}>
          <h2>What needs your attention in {factory.name}?</h2>
          <p>I can compare Tasks, recommend next work, and start or reorder Tasks when you ask.</p>
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
          send={async (message) => {
            const started = await ted.startCoordinatorChat(factory.id, { text: message, ...lead })
            if (shown.current) onStarted(started.id)
            return started
          }}
          stopTurn={async () => null}
        />
      </section>
      <CoordinatorDetails tasks={[]} onOpenTask={onOpenTask} />
    </>
  )
}

function ChatPane({
  chatId,
  factoryName,
  busy,
  error,
  onOpenTask,
  onContinue,
  onDelete,
}: {
  chatId: string
  factoryName: string
  busy: boolean
  error: string | undefined
  onOpenTask: (id: string) => void
  onContinue: () => void
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
      <section className={views.pane} aria-label="Coordinator">
        <header className={styles.header}>
          <div className={styles.titleRow}>
            <h1 className={styles.chatTitle}>{coordinator?.opening || 'Coordinator chat'}</h1>
            {coordinator && !ended && (
              <StatusChip tone={chip.tone} {...(chip.glyph && { glyph: chip.glyph })}>
                {chip.label}
              </StatusChip>
            )}
            {!ended && status === 'failed' && (
              <Button disabled={retrying} onClick={() => retry()}>
                Retry
              </Button>
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
              <span>
                This chat has ended. Continue it to send a message; your other chats keep running.
              </span>
              <span className={styles.spacer} />
              <Button disabled={busy} onClick={onDelete}>
                Delete…
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
          </>
        )}
        <ChatSection
          chat={coordinator === undefined ? undefined : (chat ?? undefined)}
          loading="Loading the Coordinator…"
          error={resource.error ?? chatResource.error}
          retry={resource.error ? resource.retry : chatResource.retry}
          options={{
            bar: false,
            extra: chatExtras(
              chatId,
              coordinator?.confirmations ?? [],
              coordinator?.receipts ?? [],
              coordinator?.tasks ?? [],
              onOpenTask,
            ),
            spot: `coordinator:${chatId}`,
            audience: 'to the Coordinator',
            humanAs: 'comment',
            tedAs: 'line',
            ...(ended
              ? {
                  readOnly: (
                    <p className={`${styles.muted} ${styles.readOnly}`}>
                      Read only. Continue this chat to send a message.
                    </p>
                  ),
                }
              : {
                  label: 'Message to the Coordinator',
                  placeholder,
                  endedPlaceholder: 'Retry the Coordinator to send a message.',
                  help,
                  live: status !== 'failed',
                  working: status === 'working' || status === 'queued' || status === 'paused',
                  interrupt: false,
                  box,
                  send: (message: string) => ted.messageCoordinator(chatId, { text: message }),
                  stopTurn: () => ted.stopCoordinator(chatId),
                }),
          }}
        />
      </section>
      <CoordinatorDetails tasks={coordinator?.tasks ?? []} onOpenTask={onOpenTask} />
    </>
  )
}

function ChatRow({
  chat,
  current,
  onOpen,
  onMenu,
}: {
  chat: CoordinatorChatSummary
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
        {chat.waiting && (
          <span className={styles.waiting} role="img" aria-label="Waiting for you" />
        )}
        {chat.lastAt && <span>{when(chat.lastAt)}</span>}
      </span>
      <span className={styles.rowTitle}>{chat.title || 'Coordinator chat'}</span>
      <span className={styles.rowMeta}>
        {chat.taskCount === 1 ? '1 Task' : `${chat.taskCount} Tasks`}
      </span>
    </ActionButton>
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
  tasks,
  onOpenTask,
}: {
  tasks: readonly Task[]
  onOpenTask: (id: string) => void
}) {
  return (
    <DetailsPane className={views.detailsPane} aria-label="Coordinator details">
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
        <p>
          Compare Tasks, decide what matters, then ask the Coordinator to start or reorder work.
          Each Task keeps its own Task Lead.
        </p>
        <p className={styles.muted}>Starts enter Intake as Queued and wait for a free Run slot.</p>
        <p className={styles.muted}>
          Each chat runs on its own, so New chat leaves your other chats running. Chats stay until
          you delete them.
        </p>
      </section>
    </DetailsPane>
  )
}
