// Adapted from agent-orchestrator (Apache-2.0): frontend/src/renderer/components/chat/
// ActivityRun.tsx and ChatTimelineItems.tsx. Ted changed: CSS Modules and RunChat items, its own
// grouping of calls (tool-groups.ts), and Edit rows that expand to their diff.
import type { RunChat as Chat, ChatDiff, ChatItem, MessageBox, RunSummary } from '@ted/protocol'
import { localFolderLine, repoShortName } from '@ted/protocol/local-folder'
import { memo, type ReactNode, useEffect, useState } from 'react'
import { sendOnEnter } from '../composer-keys.ts'
import { useRunChatState } from '../data.ts'
import { useMessageDraft } from '../message-drafts.ts'
import { useProfile } from '../profile.tsx'
import { ago, clockTime, useNow } from '../requests.ts'
import { conversationRows } from '../task-conversations.ts'
import { readableError, ted } from '../ted.ts'
import { type ToolGroup, toolGroupSummary, toolGroups } from '../tool-groups.ts'
import { ActionButton } from './ActionButton.tsx'
import { AgentAvatar, PersonAvatar } from './Avatar.tsx'
import { Button } from './Button.tsx'
import column from './ChatColumn.module.css'
import { EventLine } from './EventLine.tsx'
import { Help } from './Help.tsx'
import { ChevronIcon, ClockIcon, StopIcon } from './icons.tsx'
import { LoadingError, Skeleton } from './Loading.tsx'
import { Markdown } from './Markdown.tsx'
import { type RequestJump, RequestJumpBar } from './RequestJumpBar.tsx'
import styles from './RunChat.module.css'
import { agentNames } from './RunIcon.tsx'
import { ScrollMemory, type ScrollReveal } from './ScrollMemory.tsx'
import grow from './TextGrow.module.css'

function useTicking(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), on ? 1000 : 30_000)
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

export function tokenAmount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
  return `${tokens}`
}

export function tokenCount(tokens: number): string {
  return `${tokenAmount(tokens)} tokens`
}

export function runMeta(run: RunSummary): string {
  return [
    agentNames[run.agent],
    run.model,
    run.effort,
    run.credential,
    run.tokens !== undefined ? tokenCount(run.tokens) : undefined,
    run.cost !== undefined ? `$${run.cost.toFixed(2)}` : undefined,
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
    return request()
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
      {live &&
        (run.role === 'lead' && run.current ? (
          <Button
            disabled={onStopTask === undefined}
            title={onStopTask === undefined ? 'Stopping a Task isn’t available yet' : undefined}
            onClick={onStopTask}
          >
            Stop Task
          </Button>
        ) : (
          <Button disabled={busy} onClick={() => act(() => ted.stopRun(run.id))}>
            Stop Run
          </Button>
        ))}
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
  open?: boolean | undefined
  tone?: 'failed' | undefined
  children?: ReactNode
}) {
  const [open, setOpen] = useState(initiallyOpen)
  const empty = children === undefined || children === false || children === null
  return (
    <div className={styles.row} data-tone={tone}>
      <ActionButton
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
      </ActionButton>
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

export function Diff({ diff, showPath }: { diff: ChatDiff; showPath: boolean }) {
  const marks = { context: ' ', added: '+', removed: '-' } as const
  return (
    <div className={styles.diff} data-chat-wide-row>
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

function ToolRow({
  item,
  now,
  open,
}: {
  item: Extract<ChatItem, { kind: 'tool' }>
  now: number
  open?: boolean
}) {
  const diffs = item.diffs ?? []
  const additions = diffs.reduce((sum, d) => sum + d.additions, 0)
  const deletions = diffs.reduce((sum, d) => sum + d.deletions, 0)
  const outputLines = item.output?.trimEnd().split('\n').length ?? 0
  const meta =
    item.status === 'running' ? (
      <span className={styles.running}>
        running{item.at !== undefined && ` · ${elapsed(item.at, now)}`}
      </span>
    ) : item.status === 'stopped' ? (
      <span className={styles.stopped}>stopped</span>
    ) : diffs.length > 0 ? (
      <Counts additions={additions} deletions={deletions} />
    ) : item.status === 'failed' ? (
      <span className={styles.failed}>failed</span>
    ) : item.tool === 'Read' && outputLines > 0 ? (
      `${outputLines} lines`
    ) : (
      (item.detail ?? (outputLines === 1 ? item.output?.trim().slice(0, 80) : undefined))
    )
  const showDetail = item.detail !== undefined && meta !== item.detail
  return (
    <Collapsible
      open={open}
      label={item.tool}
      mono={item.title}
      meta={meta}
      tone={item.status === 'failed' ? 'failed' : undefined}
    >
      {(showDetail || diffs.length > 0 || item.output !== undefined) && (
        <>
          {showDetail && <pre className={styles.output}>{item.detail}</pre>}
          {diffs.map(numbered).map(({ n, ...diff }) => (
            <Diff key={n} diff={diff} showPath={diffs.length > 1 || diff.path !== item.title} />
          ))}
          {(diffs.length === 0 || item.status === 'failed') && item.output !== undefined && (
            <pre className={styles.output}>{item.output}</pre>
          )}
        </>
      )}
    </Collapsible>
  )
}

export function commandMeta(item: Extract<ChatItem, { kind: 'command' }>, now: number): string {
  const took = elapsed(item.at, item.endedAt === undefined ? now : Date.parse(item.endedAt))
  if (item.status === 'running') return `running · ${took}`
  if (item.status === 'stopped') return `Stopped · ${took}`
  if (item.status === 'passed') return `Passed · ${took}`
  return item.exitCode === undefined ? `Failed · ${took}` : `Exit code ${item.exitCode} · ${took}`
}

export function outsideMeta(item: Extract<ChatItem, { kind: 'command' }>, now: number): string {
  const base = commandMeta(item, now)
  if (!item.outside) return base
  return `${base} · Outside the sandbox${item.outside.always ? ' · Always allowed' : ''}`
}

function CommandRow({
  item,
  now,
  stopOutside,
}: {
  item: Extract<ChatItem, { kind: 'command' }>
  now: number
  stopOutside?: (() => void) | undefined
}) {
  const { outside } = item
  const running = item.status === 'running'
  const local = outside?.local && localFolderLine(outside.local, repoShortName(outside.folder))
  return (
    <Collapsible
      label={running ? 'Ted is running' : 'Ted ran'}
      mono={item.name}
      meta={outsideMeta(item, now)}
      open={outside !== undefined && running}
      tone={item.status === 'failed' ? 'failed' : undefined}
    >
      {outside && (
        <p className={styles.outsideLine} data-outside-command={item.name}>
          <code>{outside.command}</code>
          {` in ${outside.folder}`}
        </p>
      )}
      {local && (
        <p
          className={`${styles.localFolder} ${styles[local.tone] ?? ''}`}
          data-local-folder={local.tone}
        >
          {local.text}
        </p>
      )}
      {(!running || outside) && (
        <pre className={styles.output}>
          {item.output.trim() === ''
            ? running
              ? 'Waiting for output…'
              : 'No output'
            : item.output}
        </pre>
      )}
      {outside && running && stopOutside && (
        <Button size="small" onClick={stopOutside}>
          Stop
        </Button>
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
          {item.at !== undefined && <span className={styles.when}>{ago(item.at, now)}</span>}
        </div>
        <Markdown className={styles.text} text={item.text} />
      </div>
    </div>
  )
}

function QueuedActions({
  runId,
  messageId,
  sendNow,
}: {
  runId: string
  messageId: string
  sendNow: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const act = (request: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    return request()
      .catch((failed: unknown) => setError(readableError(failed)))
      .finally(() => setBusy(false))
  }
  return (
    <span className={styles.queuedActions}>
      {error !== undefined && (
        <span className={styles.error} role="alert">
          {error}
        </span>
      )}
      {sendNow && (
        <ActionButton
          type="button"
          className={styles.link}
          disabled={busy}
          onClick={() => act(() => ted.sendQueuedMessageNow(runId, messageId))}
        >
          Send now
        </ActionButton>
      )}
      <ActionButton
        type="button"
        className={styles.quietLink}
        disabled={busy}
        onClick={() => act(() => ted.deleteQueuedMessage(runId, messageId))}
      >
        Delete
      </ActionButton>
      <Help>Only until the agent has read it.</Help>
    </span>
  )
}

function HumanMessage({
  item,
  run,
  now,
  options = {},
}: {
  item: Extract<ChatItem, { kind: 'human' }>
  run?: Pick<RunSummary, 'id' | 'state' | 'role'>
  now: number
  options?: Pick<ChatOptions, 'live' | 'interrupt' | 'inspect' | 'audience'>
}) {
  const unsent = item.unsent === true
  const queued = item.queued === true || unsent
  const live = !unsent && run !== undefined && (options.live ?? run.state !== 'finished')
  const audience =
    options.audience ?? (run && (run.role === 'lead' ? 'to the Task Lead' : 'to this Run only'))
  return (
    <PersonMessage
      when={[
        audience,
        !queued ? ago(item.at, now) : undefined,
        !item.sent && !queued ? 'sending' : undefined,
      ]
        .filter((part) => part !== undefined)
        .join(' · ')}
      text={item.text}
      queued={queued}
    >
      {queued && (
        <span className={styles.queuedChip}>
          <ClockIcon />
          {live ? 'Queued' : 'Not sent'}
        </span>
      )}
      {queued && live && run && !options.inspect && (
        <QueuedActions runId={run.id} messageId={item.id} sendNow={options.interrupt !== false} />
      )}
    </PersonMessage>
  )
}

export function PersonMessage({
  when,
  text,
  queued = false,
  children,
}: {
  when: string
  text: string
  queued?: boolean
  children?: ReactNode
}) {
  const profile = useProfile()
  return (
    <div className={`${styles.message} ${styles.personMessage}`} data-queued={queued}>
      <PersonAvatar name={profile.name} photo={profile.photo} />
      <div className={styles.messageBody}>
        <div className={styles.messageHead}>
          <span className={styles.author}>{profile.name}</span>
          <span className={styles.when}>{when}</span>
          {children}
        </div>
        <Markdown className={styles.text} text={text} />
      </div>
    </div>
  )
}

function InterruptedLine({
  item,
  now,
}: {
  item: Extract<ChatItem, { kind: 'interrupted' }>
  now: number
}) {
  return (
    <p className={styles.interrupted}>
      <span className={styles.interruptedMark} aria-hidden />
      {`Interrupted by you · ${ago(item.at, now)}`}
    </p>
  )
}

function permissionAnswer(request: ChatPermission['request']):
  | {
      mark: string
      tone: string
      text: string
      at: string
    }
  | undefined {
  const { answer } = request
  if (!answer) return undefined
  if (answer.kind === 'approved')
    return { mark: '✓', tone: 'good', text: 'You approved', at: answer.at }
  if (answer.kind === 'denied') return { mark: '✕', tone: 'bad', text: 'You denied', at: answer.at }
  return { mark: '–', tone: 'quiet', text: 'Withdrawn', at: answer.at }
}

type ChatPermission = Extract<ChatItem, { kind: 'permission' }>

function PermissionRow({
  item,
  now,
  inspect,
}: {
  item: ChatPermission
  now: number
  inspect?: boolean | undefined
}) {
  const { request } = item
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const answer = permissionAnswer(request)

  async function send(action: 'approve' | 'deny') {
    setSending(true)
    setError(undefined)
    try {
      await ted.answerRequest(request.id, { action })
    } catch (failed) {
      setError(readableError(failed))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className={styles.permission} data-open={answer === undefined}>
      <div className={styles.permissionHead}>
        <span className={styles.permissionKind}>Permission</span>
        <span className={styles.rowLabel}>{request.title}</span>
        <span className={styles.rowMeta}>{ago(item.at, now)}</span>
      </div>
      {request.permission && (
        <pre className={styles.permissionCommand}>
          {request.permission.repo !== undefined && `${request.permission.repo} $ `}
          {request.permission.command}
        </pre>
      )}
      {answer ? (
        <p className={styles.permissionAnswer}>
          <span className={styles[answer.tone]} aria-hidden>
            {answer.mark}
          </span>
          {` ${answer.text} · ${ago(answer.at, now)}`}
        </p>
      ) : inspect ? (
        <p className={styles.permissionAnswer}>Awaiting an answer in the original conversation.</p>
      ) : (
        <div className={styles.permissionButtons}>
          {error !== undefined && (
            <span className={styles.error} role="alert">
              {error}
            </span>
          )}
          <Button disabled={sending} onClick={() => send('deny')}>
            Deny
          </Button>
          <Button variant="primary" disabled={sending} onClick={() => send('approve')}>
            Approve
          </Button>
        </div>
      )}
    </div>
  )
}

interface ChatRowProps {
  item: ChatItem
  run: RunSummary
  now: number
  options: ChatOptions
}

function sameRow(before: ChatRowProps, after: ChatRowProps): boolean {
  return (
    before.now === after.now &&
    before.run.id === after.run.id &&
    before.run.agent === after.run.agent &&
    before.run.name === after.run.name &&
    before.run.state === after.run.state &&
    before.options.live === after.options.live &&
    before.options.interrupt === after.options.interrupt &&
    before.options.inspect === after.options.inspect &&
    before.options.audience === after.options.audience &&
    before.options.tedAs === after.options.tedAs &&
    (before.options.stopOutside === undefined) === (after.options.stopOutside === undefined) &&
    (before.options.matchItemId === before.item.id) ===
      (after.options.matchItemId === after.item.id) &&
    (before.item === after.item || JSON.stringify(before.item) === JSON.stringify(after.item))
  )
}

const ChatRow = memo(function ChatRow({ item, run, now, options }: ChatRowProps) {
  switch (item.kind) {
    case 'instructions':
      return (
        <Collapsible
          label="Ted’s instructions for this Run"
          meta={`${item.lines} lines${item.at !== undefined ? ` · ${clockTime(item.at)}` : ''}`}
        >
          <pre className={styles.output}>{item.text}</pre>
        </Collapsible>
      )
    case 'prompt':
      return (
        <Collapsible
          label="Prompt"
          meta={`${item.lines} lines${item.at !== undefined ? ` · ${clockTime(item.at)}` : ''}`}
        >
          <pre className={styles.output}>{item.text}</pre>
        </Collapsible>
      )
    case 'ted':
      if (options.tedAs === 'line') {
        return (
          <ul className={styles.lines}>
            <EventLine
              tone="quiet"
              text={`From Ted · ${item.text.replace(/\s+/g, ' ').trim()}`}
              at={item.at ?? run.startedAt}
            />
          </ul>
        )
      }
      return (
        <Collapsible
          label="From Ted"
          mono={item.title}
          meta={item.at !== undefined ? ago(item.at, now) : undefined}
        >
          <pre className={styles.output}>{item.text}</pre>
        </Collapsible>
      )
    case 'agent':
      return <AgentMessage item={item} run={run} now={now} />
    case 'human':
      return <HumanMessage item={item} run={run} now={now} options={options} />
    case 'interrupted':
      return <InterruptedLine item={item} now={now} />
    case 'tool':
      return <ToolRow item={item} now={now} open={options.matchItemId === item.id} />
    case 'permission':
      return <PermissionRow item={item} now={now} inspect={options.inspect} />
    case 'command':
      return <CommandRow item={item} now={now} stopOutside={options.stopOutside} />
  }
}, sameRow)

export interface ChatExtra {
  id: string
  at: string
  node: ReactNode
  hidden?: boolean
}

export interface ChatOptions {
  inspect?: boolean
  matchItemId?: string
  spot?: string
  audience?: string
  tedAs?: 'line'

  header?: ((run: RunSummary) => ReactNode) | undefined
  bar?: boolean
  extra?: readonly ChatExtra[]
  pinned?: ReactNode
  requests?: readonly RequestJump[]
  revealRequest?: ScrollReveal | undefined
  onJumpRequest?: ((id: string) => void) | undefined
  label?: string
  placeholder?: string
  endedPlaceholder?: string
  help?: string
  endedNote?: string | undefined
  readOnly?: ReactNode
  live?: boolean
  working?: boolean
  interrupt?: false
  send?: (text: string) => Promise<unknown>
  stopTurn?: () => Promise<unknown>
  stopOutside?: () => void
  box?: MessageBox
}

function RunComposer({ run, options }: { run: RunSummary; options: ChatOptions }) {
  const working = options.working ?? run.state === 'working'
  return (
    <Composer
      live={options.live ?? run.state !== 'finished'}
      working={working}
      {...(options.label !== undefined && { label: options.label })}
      placeholder={options.placeholder ?? `Message the ${run.name}’s Run…`}
      endedPlaceholder={options.endedPlaceholder ?? 'This Run has finished. Its chat is read-only.'}
      help={
        options.help ??
        'Goes only to this Run. Sub-agent chats can be steered the same way from their tabs. Task comments and requests are in the Task Lead tab.'
      }
      endedNote={options.endedNote}
      interrupt={options.interrupt !== false}
      box={options.box ?? { kind: 'run', id: run.id }}
      send={
        options.send ??
        ((text, interrupt) => ted.sendRunMessage(run.id, text, { interrupt: interrupt && working }))
      }
      stopTurn={options.stopTurn ?? (() => ted.interruptRun(run.id))}
    />
  )
}

export function Composer({
  live,
  working,
  label = 'Message to this Run',
  placeholder,
  endedPlaceholder,
  help,
  endedNote,
  interrupt = true,
  box,
  send: sendText,
  stopTurn: stopRequest,
}: {
  live: boolean
  working: boolean
  label?: string
  placeholder: string
  endedPlaceholder: string
  help: string
  endedNote?: string | undefined
  interrupt?: boolean
  box?: MessageBox | undefined
  send: (text: string, interrupt: boolean) => Promise<unknown>
  stopTurn: () => Promise<unknown>
}) {
  const draft = useMessageDraft(box)
  const { text, setText } = draft
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [interrupting, setInterrupting] = useState(false)
  const [error, setError] = useState<string>()
  const typed = text.trim() !== ''

  async function send(interrupting: boolean) {
    if (!typed || sending || !live) return
    setSending(true)
    setInterrupting(interrupting)
    setError(undefined)
    try {
      await sendText(text, interrupting)
      draft.clear()
    } catch (failed) {
      setError(readableError(failed))
    } finally {
      setSending(false)
    }
  }

  async function stopTurn() {
    setStopping(true)
    setError(undefined)
    try {
      await stopRequest()
    } catch (failed) {
      setError(readableError(failed))
    } finally {
      setStopping(false)
    }
  }

  return (
    <div className={`${styles.composer} ${column.composer}`}>
      {!live && endedNote && <p className={styles.endedNote}>{endedNote}</p>}
      <textarea
        className={`${styles.box} ${grow.text}`}
        aria-label={label}
        placeholder={live ? placeholder : endedPlaceholder}
        disabled={!live}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={sendOnEnter((command) => send(command))}
      />
      {error !== undefined && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.buttons}>
        {live && (
          <Button
            aria-label="Stop the turn"
            title="Stop the turn without sending"
            disabled={stopping || !working}
            onClick={() => stopTurn()}
          >
            <StopIcon />
          </Button>
        )}
        {live && interrupt && (
          <Button
            shortcut="⌘↵"
            disabled={sending || !typed || !working}
            pending={sending && interrupting}
            onClick={() => send(true)}
          >
            Interrupt and send
          </Button>
        )}
        <Help>{help}</Help>
        <Button
          variant="primary"
          shortcut="↵"
          title={working ? 'Queues the message for the agent’s next step' : undefined}
          disabled={sending || !typed || !live}
          pending={sending && !interrupting}
          onClick={() => send(false)}
        >
          Send
        </Button>
      </div>
    </div>
  )
}

function ToolGroupRow({
  group,
  open,
  onToggle,
  children,
}: {
  group: ToolGroup
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  const summary = toolGroupSummary(group.items)
  const marks = summary.additions > 0 || summary.deletions > 0 || summary.failed > 0
  return (
    <div className={styles.row} data-tool-group={group.id}>
      <ActionButton
        type="button"
        className={styles.rowHead}
        aria-expanded={open}
        onClick={onToggle}
      >
        <ChevronIcon open={open} className={styles.chevron} />
        <span className={styles.rowLabel}>{summary.calls} tool calls</span>
        <span className={styles.groupSummary}>{summary.text}</span>
        {(marks || summary.stopped > 0 || summary.running > 0) && (
          <span className={`${styles.rowMeta} ${styles.groupMeta}`}>
            {(summary.additions > 0 || summary.deletions > 0) && (
              <Counts additions={summary.additions} deletions={summary.deletions} />
            )}
            {summary.failed > 0 && <span className={styles.failed}>{summary.failed} failed</span>}
            {summary.stopped > 0 && (
              <span className={styles.stopped}>{summary.stopped} stopped</span>
            )}
            {summary.running > 0 && (
              <span className={styles.running}>{summary.running} running</span>
            )}
          </span>
        )}
      </ActionButton>
      {open && <div className={`${styles.rowBody} ${styles.groupCalls}`}>{children}</div>}
    </div>
  )
}

export function ChatTimeline({
  chat,
  options = {},
}: {
  chat?: Chat | undefined
  options?: ChatOptions
}) {
  const items = chat?.items ?? []
  const run = chat?.run
  const rows = toolGroups(conversationRows(items, options.extra ?? [], run?.startedAt ?? ''))
  const ticking = useTicking(
    items.some(
      (item) => (item.kind === 'tool' || item.kind === 'command') && item.status === 'running',
    ),
  )
  const now = useNow()
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(new Map())
  const working = run !== undefined && (options.working ?? run.state === 'working')
  const itemRow = (item: ChatItem, run: RunSummary) => (
    <div
      key={`${run.id}:${item.kind}:${item.id}`}
      data-chat-item={item.id}
      tabIndex={options.matchItemId === item.id ? -1 : undefined}
      className={options.matchItemId === item.id ? styles.searchMatch : undefined}
    >
      <ChatRow
        item={item}
        run={run}
        now={
          (item.kind === 'tool' || item.kind === 'command') && item.status === 'running'
            ? ticking
            : now
        }
        options={options}
      />
    </div>
  )
  return (
    <>
      {rows.map((row) => {
        if ('item' in row) return run ? itemRow(row.item, run) : null
        if ('group' in row) {
          if (!run) return null
          const key = `${run.id}:${row.group.id}`
          const open =
            chosen.get(key) ??
            ((row.group.last && working) ||
              row.group.items.some((item) => item.id === options.matchItemId))
          return (
            <ToolGroupRow
              key={`group:${key}`}
              group={row.group}
              open={open}
              onToggle={() => setChosen((before) => new Map(before).set(key, !open))}
            >
              {row.group.items.map((item) => itemRow(item, run))}
            </ToolGroupRow>
          )
        }
        return (
          <div
            key={`extra:${row.extra.id}`}
            hidden={row.extra.hidden}
            data-chat-item={row.extra.id}
            tabIndex={-1}
            data-nav-item={
              options.requests?.some((request) => request.id === row.extra.id) || undefined
            }
          >
            {row.extra.node}
          </div>
        )
      })}
    </>
  )
}

export function ChatBody({
  chat,
  onStopTask,
  options = {},
}: {
  chat: Chat
  onStopTask: (() => void) | undefined
  options?: ChatOptions
}) {
  const { run, items } = chat
  const [requestReveal, setRequestReveal] = useState<ScrollReveal>()
  useEffect(() => {
    setRequestReveal(options.revealRequest)
  }, [options.revealRequest])
  const rows = conversationRows(items, options.extra ?? [], run.startedAt)
  const lastText = items.at(-1)?.kind === 'agent' ? items.at(-1) : undefined

  return (
    <>
      {!options.inspect &&
        (options.header
          ? options.header(run)
          : options.bar !== false && <RunBar run={run} onStopTask={onStopTask} />)}
      <RequestJumpBar
        requests={options.requests ?? []}
        onJump={(id) => {
          setRequestReveal({ id })
          options.onJumpRequest?.(id)
        }}
      />
      <ScrollMemory
        spot={
          options.inspect
            ? `search:${run.id}:${options.matchItemId}`
            : (options.spot ?? `run:${run.id}`)
        }
        reveal={options.matchItemId ?? requestReveal}
        count={rows.length}
        grows={lastText}
        className={`${styles.items} ${column.list}`}
      >
        <ChatTimeline chat={chat} options={options} />
      </ScrollMemory>
      {options.pinned}
      {!options.inspect && (options.readOnly ?? <RunComposer run={run} options={options} />)}
    </>
  )
}

export function RunChat({
  runId,
  onStopTask,
  ...options
}: {
  runId: string
  onStopTask?: (() => void) | undefined
} & ChatOptions) {
  const resource = useRunChatState(runId)
  return (
    <ChatSection
      chat={resource.value}
      error={resource.error}
      retry={resource.retry}
      onStopTask={onStopTask}
      options={options}
    />
  )
}

export function ChatSection({
  chat,
  loading = 'Loading the Run…',
  error,
  retry,
  onStopTask,
  options = {},
}: {
  chat: Chat | undefined
  loading?: string
  error?: string | undefined
  retry?: (() => void) | undefined
  onStopTask?: (() => void) | undefined
  options?: ChatOptions
}) {
  return (
    <section className={styles.chat} aria-label="Run chat">
      {error && retry && <LoadingError error={error} retry={retry} />}
      {chat ? (
        <ChatBody chat={chat} onStopTask={onStopTask} options={options} />
      ) : !error ? (
        <div className={styles.loading}>
          <Skeleton shape="history" label={loading} />
        </div>
      ) : null}
    </section>
  )
}
