// Adapted from agent-orchestrator (Apache-2.0): frontend/src/renderer/components/chat/ActivityRun.tsx
// and ChatTimelineItems.tsx (collapsible tool-call rows with +/− counts, the running state, and
// the human bubble). TED changed: rewritten for TED’s CSS Modules and RunChat items, with no
// grouping of calls, an Edit row that expands to its diff, and a Run bar and composer of its own.
import type { RunChat as Chat, ChatDiff, ChatItem, RunSummary } from '@ted/protocol'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useRunChat } from '../data.ts'
import { ago, useNow } from '../requests.ts'
import { readableError, ted } from '../ted.ts'
import { AgentAvatar } from './Avatar.tsx'
import { Button } from './Button.tsx'
import { ChevronIcon } from './icons.tsx'
import styles from './RunChat.module.css'
import { agentNames } from './RunIcon.tsx'

const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

function useTicking(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [on])
  return now
}

function elapsed(from: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(from)) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function tokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tokens`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k tokens`
  return `${tokens} tokens`
}

export function runMeta(run: RunSummary): string {
  return [
    agentNames[run.agent],
    run.model,
    run.effort,
    run.credential,
    run.tokens !== undefined ? tokenCount(run.tokens) : undefined,
  ]
    .filter((part) => part !== undefined && part !== '')
    .join(' · ')
}

function RunBar({ run, onStopTask }: { run: RunSummary; onStopTask: (() => void) | undefined }) {
  const now = useNow()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const live = run.state !== 'finished'
  const act = (request: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    request()
      .catch((failed: unknown) => setError(readableError(failed)))
      .finally(() => setBusy(false))
  }
  return (
    <div className={styles.bar}>
      <AgentAvatar agent={run.agent} />
      <div className={styles.barText}>
        <span className={styles.barName}>{run.name}</span>
        <span className={styles.barMeta}>
          {runMeta(run)}
          {` · started ${ago(run.startedAt, now)}`}
          {!live && ' · finished'}
        </span>
      </div>
      {error !== undefined && (
        <span className={styles.barError} role="alert">
          {error}
        </span>
      )}
      {live && (
        <>
          <Button
            size="small"
            disabled={busy || run.state === 'working'}
            title={run.state === 'working' ? 'Restart works when the Run is idle' : undefined}
            onClick={() => act(() => ted.restartRun(run.id))}
          >
            Restart
          </Button>
          {run.role === 'lead' && run.current ? (
            <Button
              size="small"
              disabled={onStopTask === undefined}
              title={onStopTask === undefined ? 'Stopping a Task isn’t available yet' : undefined}
              onClick={onStopTask}
            >
              Stop Task
            </Button>
          ) : (
            <Button size="small" disabled={busy} onClick={() => act(() => ted.stopRun(run.id))}>
              Stop Run
            </Button>
          )}
        </>
      )}
    </div>
  )
}

function Collapsible({
  label,
  mono,
  meta,
  open: initiallyOpen = false,
  tone,
  children,
}: {
  label: ReactNode
  mono?: ReactNode
  meta?: ReactNode
  open?: boolean
  tone?: 'failed' | undefined
  children?: ReactNode
}) {
  const [open, setOpen] = useState(initiallyOpen)
  const empty = children === undefined || children === false || children === null
  return (
    <div className={styles.row} data-tone={tone}>
      <button
        type="button"
        className={styles.rowHead}
        aria-expanded={empty ? undefined : open}
        disabled={empty}
        onClick={() => setOpen(!open)}
      >
        <ChevronIcon open={open && !empty} className={styles.chevron} />
        <span className={styles.rowLabel}>{label}</span>
        {mono !== undefined && <span className={styles.rowMono}>{mono}</span>}
        {meta !== undefined && <span className={styles.rowMeta}>{meta}</span>}
      </button>
      {open && !empty && <div className={styles.rowBody}>{children}</div>}
    </div>
  )
}

function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className={styles.counts}>
      {additions > 0 && <span className={styles.added}>+{additions}</span>}
      {deletions > 0 && <span className={styles.removed}>−{deletions}</span>}
    </span>
  )
}

const numbered = <T,>(value: T, n: number) => ({ ...value, n })

function Diff({ diff, showPath }: { diff: ChatDiff; showPath: boolean }) {
  const marks = { context: ' ', added: '+', removed: '-' } as const
  return (
    <div className={styles.diff}>
      {showPath && <div className={styles.diffPath}>{diff.path}</div>}
      {diff.lines.map(numbered).map(({ n, ...line }) => (
        <div key={n} className={`${styles.diffLine} ${styles[line.kind]}`}>
          <span className={styles.diffMark}>{marks[line.kind]}</span>
          <span>{line.text}</span>
        </div>
      ))}
      {diff.truncated && <div className={styles.diffMore}>Longer than shown</div>}
    </div>
  )
}

function ToolRow({ item, now }: { item: Extract<ChatItem, { kind: 'tool' }>; now: number }) {
  const diffs = item.diffs ?? []
  const additions = diffs.reduce((sum, d) => sum + d.additions, 0)
  const deletions = diffs.reduce((sum, d) => sum + d.deletions, 0)
  const outputLines = item.output?.trimEnd().split('\n').length ?? 0
  const meta =
    item.status === 'running' ? (
      <span className={styles.running}>
        running{item.at !== undefined && ` · ${elapsed(item.at, now)}`}
      </span>
    ) : diffs.length > 0 ? (
      <Counts additions={additions} deletions={deletions} />
    ) : item.status === 'failed' ? (
      <span className={styles.failed}>failed</span>
    ) : item.tool === 'Read' && outputLines > 0 ? (
      `${outputLines} lines`
    ) : (
      item.detail
    )
  return (
    <Collapsible
      label={item.tool}
      mono={item.title}
      meta={meta}
      tone={item.status === 'failed' ? 'failed' : undefined}
    >
      {(diffs.length > 0 || item.output !== undefined) && (
        <>
          {diffs.map(numbered).map(({ n, ...diff }) => (
            <Diff key={n} diff={diff} showPath={diffs.length > 1 || diff.path !== item.title} />
          ))}
          {diffs.length === 0 && item.output !== undefined && (
            <pre className={styles.output}>{item.output}</pre>
          )}
        </>
      )}
    </Collapsible>
  )
}

function AgentMessage({
  item,
  run,
  now,
}: {
  item: Extract<ChatItem, { kind: 'agent' }>
  run: RunSummary
  now: number
}) {
  return (
    <div className={styles.message}>
      <AgentAvatar agent={run.agent} />
      <div className={styles.messageBody}>
        <div className={styles.messageHead}>
          <span className={styles.author}>{run.name}</span>
          {item.at !== undefined && (
            <span className={item.writing ? styles.writing : styles.when}>
              {ago(item.at, now)}
              {item.writing && ' · writing…'}
            </span>
          )}
          {item.at === undefined && item.writing && (
            <span className={styles.writing}>writing…</span>
          )}
        </div>
        <p className={styles.text}>{item.text}</p>
      </div>
    </div>
  )
}

function HumanMessage({ item, now }: { item: Extract<ChatItem, { kind: 'human' }>; now: number }) {
  return (
    <div className={styles.human}>
      <div className={styles.bubble}>
        <div className={styles.messageHead}>
          <span className={styles.author}>You</span>
          <span className={styles.when}>
            {` · to this Run only · ${ago(item.at, now)}`}
            {!item.sent && ' · sending'}
          </span>
        </div>
        <p className={styles.text}>{item.text}</p>
      </div>
    </div>
  )
}

function ChatRow({ item, run, now }: { item: ChatItem; run: RunSummary; now: number }) {
  switch (item.kind) {
    case 'instructions':
      return (
        <Collapsible
          label="TED’s instructions for this Run"
          meta={`${item.lines} lines${item.at !== undefined ? ` · ${clock.format(new Date(item.at))}` : ''}`}
        >
          <pre className={styles.output}>{item.text}</pre>
        </Collapsible>
      )
    case 'prompt':
      return (
        <Collapsible
          label="Prompt"
          meta={`${item.lines} lines${item.at !== undefined ? ` · ${clock.format(new Date(item.at))}` : ''}`}
        >
          <pre className={styles.output}>{item.text}</pre>
        </Collapsible>
      )
    case 'ted':
      return (
        <Collapsible
          label="From TED"
          mono={item.title}
          meta={item.at !== undefined ? ago(item.at, now) : undefined}
        >
          <pre className={styles.output}>{item.text}</pre>
        </Collapsible>
      )
    case 'agent':
      return <AgentMessage item={item} run={run} now={now} />
    case 'human':
      return <HumanMessage item={item} now={now} />
    case 'tool':
      return <ToolRow item={item} now={now} />
  }
}

function Composer({ run }: { run: RunSummary }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const typed = text.trim() !== ''
  const live = run.state !== 'finished'

  async function send() {
    if (!typed || sending || !live) return
    setSending(true)
    setError(undefined)
    try {
      await ted.sendRunMessage(run.id, text)
      setText('')
    } catch (failed) {
      setError(readableError(failed))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className={styles.composer}>
      <textarea
        className={styles.box}
        aria-label="Message to this Run"
        placeholder={
          live ? `Message the ${run.name}’s Run…` : 'This Run has finished. Its chat is read-only.'
        }
        disabled={!live}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
          event.preventDefault()
          void send()
        }}
      />
      {error !== undefined && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.buttons}>
        <span className={styles.hint}>Goes only to this Run. It isn’t a Comment.</span>
        <Button
          variant="primary"
          size="small"
          shortcut="↵"
          disabled={sending || !typed || !live}
          onClick={() => void send()}
        >
          Send
        </Button>
      </div>
    </div>
  )
}

function ChatBody({ chat, onStopTask }: { chat: Chat; onStopTask: (() => void) | undefined }) {
  const { run, items } = chat
  const running = items.some((i) => i.kind === 'tool' && i.status === 'running')
  const now = useTicking(running)
  const list = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const count = items.length
  const lastText = items.at(-1)?.kind === 'agent' ? items.at(-1) : undefined

  useEffect(() => {
    void count
    void lastText
    const element = list.current
    if (element && pinned.current) element.scrollTop = element.scrollHeight
  }, [count, lastText])

  return (
    <>
      <RunBar run={run} onStopTask={onStopTask} />
      <div
        ref={list}
        className={styles.items}
        onScroll={(event) => {
          const element = event.currentTarget
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40
        }}
      >
        {items.map((item) => (
          <ChatRow key={`${item.kind}:${item.id}`} item={item} run={run} now={now} />
        ))}
      </div>
      <Composer run={run} />
    </>
  )
}

export function RunChat({
  runId,
  onStopTask,
}: {
  runId: string
  onStopTask?: (() => void) | undefined
}) {
  const chat = useRunChat(runId)
  return (
    <section className={styles.chat} aria-label="Run chat">
      {chat ? (
        <ChatBody chat={chat} onStopTask={onStopTask} />
      ) : (
        <p className={styles.loading}>Loading the Run…</p>
      )}
    </section>
  )
}
