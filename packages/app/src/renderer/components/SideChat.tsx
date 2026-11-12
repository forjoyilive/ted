import type { SideChat as Chat } from '@ted/protocol'
import { useRef, useState } from 'react'
import { useEventValue, useRunChatState } from '../data.ts'
import { clockTime } from '../requests.ts'
import { readableError, ted } from '../ted.ts'
import { AntigravityChatWarning } from './AntigravityChatWarning.tsx'
import { Button } from './Button.tsx'
import { type ChatOptions, ChatSection } from './RunChat.tsx'
import styles from './SideChat.module.css'

type Props = { runId: string; onStopTask?: (() => void) | undefined } & ChatOptions

export function RunWithSideChat(props: Props) {
  return <RunSideChat key={props.runId} {...props} />
}

function RunSideChat({
  runId,
  onStopTask,
  ...options
}: { runId: string; onStopTask?: (() => void) | undefined } & ChatOptions) {
  const resource = useRunChatState(runId)
  const chat = resource.value
  const [open, setOpen] = useState(false)
  const [which, setWhich] = useState<'source' | 'side'>('source')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const sideId = useRef<string | undefined>(undefined)
  const eligible = chat?.run.role === 'lead'
  const { value: side, update } = useEventValue<Chat | null | undefined>({
    initial: undefined,
    key: runId,
    enabled: eligible,
    load: () => ted.getSideChat(runId),
    event: (event) =>
      (event.type === 'side-chat-changed' && event.sourceRunId === runId) ||
      (event.type === 'run-output' && event.runId === sideId.current) ||
      (event.type === 'run-updated' && event.run.id === sideId.current) ||
      event.type === 'agent-health-changed' ||
      event.type === 'slots-changed'
        ? 'reload'
        : undefined,
    error: (failed) => setError(readableError(failed)),
  })
  sideId.current = side?.id

  const act = async (request: () => Promise<Chat>) => {
    setBusy(true)
    setError(undefined)
    try {
      const next = await request()
      update(() => next)
    } catch (failed) {
      setError(readableError(failed))
      throw failed
    } finally {
      setBusy(false)
    }
  }
  const show = () => {
    setOpen(true)
    setWhich('side')
    void act(() => ted.openSideChat(runId)).catch(() => undefined)
  }
  const working = side?.state === 'working' || side?.state === 'queued'
  return (
    <div className={styles.container}>
      {eligible && open && (
        <nav className={styles.switch} aria-label="Conversation view">
          <Button size="small" aria-pressed={which === 'source'} onClick={() => setWhich('source')}>
            Original Run · {chat.run.state}
          </Button>
          <Button size="small" aria-pressed={which === 'side'} onClick={() => setWhich('side')}>
            Side chat
          </Button>
        </nav>
      )}
      <div className={styles.panes} data-open={open}>
        <div className={styles.source} data-hidden={open && which !== 'source'}>
          {eligible && options.bar === false && (
            <div className={styles.actions}>
              <Button size="small" disabled={busy} onClick={show}>
                {side ? 'Open side chat' : 'Side chat'}
              </Button>
            </div>
          )}
          <ChatSection
            chat={chat}
            error={resource.error}
            retry={resource.retry}
            onStopTask={onStopTask}
            options={{
              ...options,
              headerAction: eligible && (
                <Button size="small" disabled={busy} onClick={show}>
                  {side ? 'Open side chat' : 'Side chat'}
                </Button>
              ),
            }}
          />
        </div>
        {eligible && open && (
          <section className={styles.side} data-hidden={which !== 'side'} aria-label="Side chat">
            <header className={styles.header}>
              <strong>Side chat</strong>
              <span>
                {side?.paused
                  ? 'Paused'
                  : side?.state === 'queued'
                    ? 'Queued'
                    : side?.state === 'working'
                      ? 'Replying'
                      : side?.state === 'failed'
                        ? 'Interrupted'
                        : 'Ready'}
              </span>
              <Button
                size="small"
                aria-label="Close side chat"
                onClick={() => {
                  setOpen(false)
                  setWhich('source')
                }}
              >
                ×
              </Button>
            </header>
            {side && <AntigravityChatWarning agent={side.chat.run.agent} />}
            {side && (
              <div className={styles.notice}>
                <div>Conversation snapshot · {clockTime(side.snapshotAt)}</div>
                <div>Answers stay here. The original Run keeps working.</div>
                {side.truncated && (
                  <div>Earlier context omitted · uses opening context and recent messages.</div>
                )}
              </div>
            )}
            {(error || side?.error || side?.paused) && (
              <p className={styles.error} role="alert">
                {error ?? side?.error ?? side?.paused}
              </p>
            )}
            {side?.state === 'queued' && (
              <p className={styles.notice}>
                Waiting for a working slot. The original Run continues.
              </p>
            )}
            {side?.chat && (
              <ChatSection
                chat={side.chat}
                options={{
                  bar: false,
                  label: 'Question for this side chat',
                  placeholder: working ? 'Wait for this reply to finish…' : 'Ask about this Run…',
                  endedPlaceholder: working
                    ? 'Waiting for this reply to finish…'
                    : busy
                      ? 'Sending…'
                      : 'This side chat’s output is no longer kept.',
                  help:
                    side.chat.run.agent === 'antigravity'
                      ? 'Uses the starting Conversation snapshot. Antigravity can use built-in tools; see the help beside the tool warning.'
                      : 'Answers only from the starting Conversation snapshot. It can’t inspect files or change the Task.',
                  live: side.available && !working && !busy,
                  working: false,
                  interrupt: false,
                  send: async (text) => {
                    await act(() => ted.sendSideChat(runId, text))
                  },
                  readOnly: side.available ? undefined : (
                    <p className={styles.notice}>
                      This side chat’s snapshot is no longer kept. Its history is read-only.
                    </p>
                  ),
                  pinned: working ? (
                    <div className={styles.actions}>
                      <Button
                        size="small"
                        disabled={busy}
                        onClick={() => {
                          void act(() => ted.stopSideChat(runId)).catch(() => undefined)
                        }}
                      >
                        Stop reply
                      </Button>
                    </div>
                  ) : side.state === 'failed' ? (
                    <div className={styles.actions}>
                      <Button
                        size="small"
                        disabled={busy}
                        onClick={() => {
                          void act(() => ted.retrySideChat(runId)).catch(() => undefined)
                        }}
                      >
                        Retry
                      </Button>
                    </div>
                  ) : side.chat.items.length === 0 ? (
                    <div className={styles.notice}>
                      Ask about this Run. It answers from the Conversation as it was when you opened
                      this side chat.
                    </div>
                  ) : undefined,
                }}
              />
            )}
            {!side && (
              <p className={styles.notice}>
                {busy ? 'Opening side chat…' : 'The side chat could not be opened.'}
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
