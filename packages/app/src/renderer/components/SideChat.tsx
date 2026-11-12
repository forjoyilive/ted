import type { SideChat as Chat } from '@ted/protocol'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useEventValue, useRunChatState } from '../data.ts'
import { clockTime } from '../requests.ts'
import { readableError, ted } from '../ted.ts'
import { AntigravityChatWarning } from './AntigravityChatWarning.tsx'
import { Button } from './Button.tsx'
import { type ChatOptions, ChatSection } from './RunChat.tsx'
import styles from './SideChat.module.css'

const outputEveryMs = 1_000
const slotsEveryMs = 500

type Props = {
  runId: string | undefined
  onStopTask?: (() => void) | undefined
  openSideChat?: boolean
  onSideChatOpened?: (() => void) | undefined
  renderSource?: (resource: ReturnType<typeof useRunChatState>) => ReactNode
} & ChatOptions

export function RunWithSideChat(props: Props) {
  return <RunSideChat key={props.renderSource ? undefined : props.runId} {...props} />
}

function RunSideChat({
  runId,
  onStopTask,
  openSideChat = false,
  onSideChatOpened,
  renderSource,
  ...options
}: Props) {
  const resource = useRunChatState(runId)
  const chat = resource.value
  const [open, setOpen] = useState(false)
  const [which, setWhich] = useState<'source' | 'side'>('source')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const sideId = useRef<string | undefined>(undefined)
  const sourceId = useRef(runId)
  sourceId.current = runId
  useEffect(() => {
    void runId
    setOpen(false)
    setWhich('source')
    setError(undefined)
    setBusy(false)
  }, [runId])
  const eligible = chat?.run.role === 'lead'
  const { value: side, update } = useEventValue<Chat | null | undefined>({
    initial: undefined,
    key: runId ?? '',
    enabled: eligible,
    load: () => (runId === undefined ? Promise.resolve(null) : ted.getSideChat(runId)),
    event: (event) => {
      if (event.type === 'run-output' && event.runId === sideId.current)
        return event.lines ? outputEveryMs : 'reload'
      if (event.type === 'slots-changed') return slotsEveryMs
      return (event.type === 'side-chat-changed' && event.sourceRunId === runId) ||
        (event.type === 'run-updated' && event.run.id === sideId.current) ||
        event.type === 'agent-health-changed'
        ? 'reload'
        : undefined
    },
    error: (failed) => setError(readableError(failed)),
  })
  sideId.current = side?.id

  const act = async (request: (source: string) => Promise<Chat>) => {
    if (runId === undefined) return
    const source = runId
    setBusy(true)
    setError(undefined)
    try {
      const next = await request(runId)
      if (sourceId.current === source) update(() => next)
    } catch (failed) {
      if (sourceId.current === source) setError(readableError(failed))
      throw failed
    } finally {
      if (sourceId.current === source) setBusy(false)
    }
  }
  const show = () => {
    setOpen(true)
    setWhich('side')
    return act((source) => ted.openSideChat(source)).catch(() => undefined)
  }
  const opened = useRef(onSideChatOpened)
  opened.current = onSideChatOpened
  const showRef = useRef(show)
  showRef.current = show
  useEffect(() => {
    if (!openSideChat || !eligible) return
    void showRef.current()
    opened.current?.()
  }, [openSideChat, eligible])
  const working = side?.state === 'working' || side?.state === 'queued'
  return (
    <div className={styles.container}>
      {eligible && open && (
        <nav className={styles.switch} aria-label="Conversation view">
          <Button aria-pressed={which === 'source'} onClick={() => setWhich('source')}>
            Original Run · {chat.run.state}
          </Button>
          <Button aria-pressed={which === 'side'} onClick={() => setWhich('side')}>
            Side chat
          </Button>
        </nav>
      )}
      <div className={styles.panes} data-open={open}>
        <div className={styles.source} data-hidden={open && which !== 'source'}>
          {renderSource ? (
            renderSource(resource)
          ) : (
            <ChatSection
              chat={chat}
              error={resource.error}
              retry={resource.retry}
              onStopTask={onStopTask}
              options={options}
            />
          )}
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
                aria-label="Close side chat"
                onClick={() => {
                  setOpen(false)
                  setWhich('source')
                }}
              >
                ×
              </Button>
            </header>
            {side?.chat && <AntigravityChatWarning agent={side.chat.run.agent} />}
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
                    await act((source) => ted.sendSideChat(source, text))
                  },
                  readOnly: side.available ? undefined : (
                    <p className={styles.notice}>
                      This side chat’s snapshot is no longer kept. Its history is read-only.
                    </p>
                  ),
                  pinned: working ? (
                    <div className={styles.actions}>
                      <Button
                        disabled={busy}
                        onClick={() => {
                          return act((source) => ted.stopSideChat(source)).catch(() => undefined)
                        }}
                      >
                        Stop reply
                      </Button>
                    </div>
                  ) : side.state === 'failed' ? (
                    <div className={styles.actions}>
                      <Button
                        disabled={busy}
                        onClick={() => {
                          return act((source) => ted.retrySideChat(source)).catch(() => undefined)
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
