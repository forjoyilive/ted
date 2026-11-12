import type { Coordinator, Factory, MessageBox, TaskLead } from '@ted/protocol'
import { useEffect, useState } from 'react'
import dialogs from '../components/ArchiveDialogs.module.css'
import { Dialog } from '../components/ArchiveDialogs.tsx'
import { Button } from '../components/Button.tsx'
import { DetailsPane } from '../components/ResizableSidebar.tsx'
import { ChatSection, Composer, runMeta } from '../components/RunChat.tsx'
import { StatusChip, type StatusGlyph, type StatusTone } from '../components/StatusChip.tsx'
import { statusLabel } from '../components/TaskStatus.tsx'
import { useCoordinatorChatState, useCoordinatorState } from '../data.ts'
import { useMessageDraft } from '../message-drafts.ts'
import { clockTime } from '../requests.ts'
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
  const reset = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await ted.resetCoordinator(factory.id)
      setResetting(false)
    } catch (failed) {
      setError(readableError(failed))
    } finally {
      setBusy(false)
    }
  }
  const status = coordinator?.status ?? 'ready'
  const shown = coordinatorStatus[status]
  return (
    <>
      <section className={views.pane} aria-label="Coordinator">
        <header className={styles.header}>
          <div className={styles.titleRow}>
            <h1>Coordinator</h1>
            <StatusChip tone={shown.tone} {...(shown.glyph && { glyph: shown.glyph })}>
              {shown.label}
            </StatusChip>
            <span className={styles.spacer} />
            {coordinator === null && lead ? (
              <LeadSelects lead={lead} onChange={setLead} />
            ) : (
              chat && <span className={styles.meta}>{runMeta(chat.run)}</span>
            )}
            {status === 'failed' && (
              <Button size="small" disabled={busy} onClick={() => void retry()}>
                Retry
              </Button>
            )}
            {coordinator && (
              <Button size="small" disabled={busy} onClick={() => setResetting(true)}>
                New conversation
              </Button>
            )}
          </div>
          <p>{factory.name} · One conversation for this Factory</p>
          {(error ?? coordinator?.error) && <p role="alert">{error ?? coordinator?.error}</p>}
        </header>
        {coordinator === null ? (
          <>
            <div className={styles.intro}>
              <h2>What needs your attention in {factory.name}?</h2>
              <p>
                I can compare Tasks, recommend next work, and start or reorder Tasks when you ask.
              </p>
              <Button size="small" onClick={() => setText('What should we work on next?')}>
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
              extra: (coordinator?.receipts ?? []).map((receipt) => ({
                id: receipt.id,
                at: receipt.at,
                node: (
                  <p className={styles.event}>
                    <span className={styles.dot} aria-hidden />
                    <button
                      type="button"
                      className={styles.eventText}
                      onClick={() => onOpenTask(receipt.taskId)}
                    >
                      {receipt.text}
                    </button>
                    <time className={styles.eventTime}>{clockTime(receipt.at)}</time>
                  </p>
                ),
              })),
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
      {resetting && (
        <Dialog onClose={() => !busy && setResetting(false)}>
          {(headingId) => (
            <>
              <h2 id={headingId} className={dialogs.heading}>
                Start a new Coordinator conversation?
              </h2>
              <p className={dialogs.body}>
                {`This stops the Coordinator and deletes its conversation for ${factory.name}, with any messages it hasn’t read. Tasks stay as they are, and so does everything the Coordinator already did to them.`}
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
                <Button variant="primary" disabled={busy} onClick={() => void reset()}>
                  Delete and start new
                </Button>
              </div>
            </>
          )}
        </Dialog>
      )}
      <DetailsPane className={views.detailsPane} aria-label="Coordinator details">
        <section className={styles.section}>
          <h2>Tasks in this conversation</h2>
          {coordinator?.tasks.length ? (
            coordinator.tasks.map((task) => (
              <button
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
              </button>
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
          <p className={styles.muted}>
            Starts enter Intake as Queued and wait for a free Run slot.
          </p>
        </section>
      </DetailsPane>
    </>
  )
}
