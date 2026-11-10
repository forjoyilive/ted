import type { Factory, TaskLead } from '@ted/protocol'
import { useEffect, useState } from 'react'
import { Button } from '../components/Button.tsx'
import { RunChat } from '../components/RunChat.tsx'
import { StatusChip } from '../components/StatusChip.tsx'
import { statusLabel } from '../components/TaskStatus.tsx'
import { sendOnEnter } from '../composer-keys.ts'
import { useCoordinator } from '../data.ts'
import { clockTime } from '../requests.ts'
import { readableError, ted } from '../ted.ts'
import styles from './Coordinator.module.css'
import { LeadSelects } from './PlanChat.tsx'
import views from './views.module.css'

export function CoordinatorView({
  factory,
  onOpenTask,
}: {
  factory: Factory
  onOpenTask: (id: string) => void
}) {
  const chat = useCoordinator(factory.id)
  const [text, setText] = useState('')
  const [lead, setLead] = useState<TaskLead>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
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
  async function act(work: () => Promise<unknown>) {
    setBusy(true)
    setError(undefined)
    try {
      await work()
    } catch (error) {
      setError(readableError(error))
    } finally {
      setBusy(false)
    }
  }
  const send = () => {
    if (text.trim() === '' || busy || chat === undefined) return
    void act(async () => {
      await ted.messageCoordinator(factory.id, { text, ...(!chat && lead) })
      setText('')
    })
  }
  const status = chat?.status ?? 'ready'
  const labels = {
    ready: 'Ready',
    queued: 'Queued',
    working: 'Working',
    paused: 'Paused',
    failed: 'Failed',
  }
  return (
    <>
      <section className={views.pane} aria-label="Coordinator">
        <header className={styles.header}>
          <div className={styles.titleRow}>
            <h1>Coordinator</h1>
            <StatusChip
              tone={status === 'working' ? 'working' : status === 'failed' ? 'failed' : 'neutral'}
            >
              {labels[status]}
            </StatusChip>
            <span className={styles.spacer} />
            {!chat && lead ? (
              <LeadSelects lead={lead} onChange={setLead} />
            ) : (
              chat && (
                <span className={styles.meta}>
                  {[chat.lead.agent, chat.lead.model, chat.lead.effort].filter(Boolean).join(' · ')}
                </span>
              )
            )}
            {chat && (status === 'working' || status === 'queued' || status === 'paused') && (
              <Button
                size="small"
                disabled={busy}
                onClick={() => void act(() => ted.stopCoordinator(factory.id))}
              >
                Stop response
              </Button>
            )}
            {chat?.status === 'failed' && (
              <Button
                size="small"
                disabled={busy}
                onClick={() => void act(() => ted.retryCoordinator(factory.id))}
              >
                Retry
              </Button>
            )}
          </div>
          <p>{factory.name} · One conversation for this Factory</p>
          {chat?.error && <p role="alert">{chat.error}</p>}
        </header>
        {chat?.runIds
          .filter((id) => id !== chat.runId)
          .map((id) => (
            <details key={id} className={styles.earlier}>
              <summary>Earlier conversation</summary>
              <div className={styles.history}>
                <RunChat runId={id} bar={false} readOnly={false} />
              </div>
            </details>
          ))}
        {chat?.started ? (
          <RunChat
            runId={chat.runId}
            bar={false}
            readOnly={false}
            extra={chat.receipts.map((receipt) => ({
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
            }))}
          />
        ) : (
          <div className={styles.intro}>
            {chat ? (
              <>
                <p>{chat.opening}</p>
                <p className={styles.muted}>
                  {status === 'queued' ? 'Waiting for a free Run slot…' : labels[status]}
                </p>
              </>
            ) : (
              <>
                <h2>What needs your attention in {factory.name}?</h2>
                <p>
                  I can compare Tasks, recommend next work, and start or reorder Tasks when you ask.
                </p>
                <Button size="small" onClick={() => setText('What should we work on next?')}>
                  What should we work on next?
                </Button>
              </>
            )}
          </div>
        )}
        <div className={styles.composer}>
          <textarea
            aria-label="Message Coordinator"
            placeholder="Ask about Tasks, or say what to start next…"
            value={text}
            disabled={busy || chat === undefined || status === 'failed'}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={sendOnEnter(send)}
          />
          {error && <p role="alert">{error}</p>}
          <div className={styles.titleRow}>
            <span className={styles.muted}>Messages stay in this conversation.</span>
            <span className={styles.spacer} />
            <Button
              size="small"
              variant="primary"
              disabled={busy || chat === undefined || text.trim() === '' || status === 'failed'}
              onClick={send}
            >
              Send
            </Button>
          </div>
        </div>
      </section>
      <aside className={views.detailsPane} aria-label="Coordinator details">
        <section className={styles.section}>
          <h2>Tasks in this conversation</h2>
          {chat?.tasks.length ? (
            chat.tasks.map((task) => (
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
      </aside>
    </>
  )
}
