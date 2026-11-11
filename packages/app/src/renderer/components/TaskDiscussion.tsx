import type { AgentStageId, Comment, RunChat, RunSummary, StageEntry } from '@ted/protocol'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useRunChatState } from '../data.ts'
import { clockTime } from '../requests.ts'
import { conversationInStage } from '../task-conversations.ts'
import { formatDate } from '../time.ts'
import { LoadingError, Skeleton } from './Loading.tsx'
import { type ChatExtra, ChatTimeline } from './RunChat.tsx'
import { ScrollMemory, type ScrollReveal } from './ScrollMemory.tsx'
import { RunWithSideChat } from './SideChat.tsx'
import styles from './TaskDiscussion.module.css'

function visibleChat(
  chat: RunChat | undefined,
  comments: readonly Comment[],
  entries: readonly StageEntry[],
  stage: AgentStageId | undefined,
) {
  if (!chat) return undefined
  const commentIds = new Set(comments.map((comment) => comment.id))
  return {
    ...chat,
    items: conversationInStage(chat.items, chat.run.startedAt, entries, stage).filter(
      (item) => item.kind !== 'permission' || !commentIds.has(item.request.id),
    ),
  }
}

export function TaskDiscussion({
  taskId,
  leadRunId,
  earlier,
  revealRun,
  revealRequest,
  comments,
  entries,
  stage,
  extra,
  footer,
  active,
  loading,
}: {
  taskId: string
  leadRunId: string | undefined
  earlier: readonly RunSummary[]
  revealRun: string | ScrollReveal | undefined
  revealRequest?: ScrollReveal | undefined
  comments: readonly Comment[]
  entries: readonly StageEntry[]
  stage: AgentStageId | undefined
  extra: readonly ChatExtra[]
  footer: (chat: RunChat | undefined) => ReactNode
  active: boolean
  loading: boolean
}) {
  const conversationTarget =
    typeof revealRun === 'string' ? `conversation:${revealRun}` : revealRun?.id
  const body = (chat: RunChat | undefined, error?: string, retry?: () => void) => {
    const shown = visibleChat(chat, comments, entries, stage)
    return (
      <section className={styles.container} aria-label="Run chat">
        <ScrollMemory
          spot={`thread:${taskId}`}
          count={
            loading
              ? 0
              : extra.filter((row) => !row.hidden).length +
                (shown?.items.length ?? 0) +
                earlier.length
          }
          grows={shown?.items.at(-1)}
          reveal={
            revealRun !== undefined
              ? typeof revealRun === 'string'
                ? `conversation:${revealRun}`
                : revealRun
              : revealRequest
          }
          active={active}
          className={styles.items}
        >
          {earlier.map((run) => (
            <EarlierConversation
              key={run.id}
              run={run}
              reveal={conversationTarget === `conversation:${run.id}` ? revealRun : undefined}
              comments={comments}
              entries={entries}
              stage={stage}
            />
          ))}
          {error && retry && <LoadingError error={error} retry={retry} />}
          {leadRunId && !chat && !error && (
            <Skeleton shape="history" label="Loading Task Lead conversation…" />
          )}
          <ChatTimeline chat={shown} options={{ extra }} />
        </ScrollMemory>
        {footer(chat)}
      </section>
    )
  }
  return leadRunId ? (
    <RunWithSideChat
      runId={leadRunId}
      bar={false}
      renderSource={(resource) => body(resource.value, resource.error, resource.retry)}
    />
  ) : (
    body(undefined)
  )
}

function EarlierConversation({
  run,
  reveal,
  comments,
  entries,
  stage,
}: {
  run: RunSummary
  reveal: string | ScrollReveal | undefined
  comments: readonly Comment[]
  entries: readonly StageEntry[]
  stage: AgentStageId | undefined
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    if (reveal) {
      setOpen(true)
      ref.current?.querySelector('summary')?.focus({ preventScroll: true })
    }
  }, [reveal])
  return (
    <details
      ref={ref}
      open={open}
      className={styles.earlier}
      data-chat-item={`conversation:${run.id}`}
      tabIndex={-1}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        Earlier conversation ·{' '}
        {formatDate(run.startedAt, { day: 'numeric', month: 'short', year: 'numeric' })} ·{' '}
        {clockTime(run.startedAt)}
      </summary>
      {open && (
        <EarlierMessages runId={run.id} comments={comments} entries={entries} stage={stage} />
      )}
    </details>
  )
}

function EarlierMessages({
  runId,
  comments,
  entries,
  stage,
}: {
  runId: string
  comments: readonly Comment[]
  entries: readonly StageEntry[]
  stage: AgentStageId | undefined
}) {
  const resource = useRunChatState(runId)
  const chat = visibleChat(resource.value, comments, entries, stage)
  return (
    <div className={styles.olderItems}>
      {resource.error && <LoadingError error={resource.error} retry={resource.retry} />}
      {!chat && !resource.error && (
        <Skeleton shape="history" label="Loading earlier conversation…" />
      )}
      <ChatTimeline chat={chat} options={{ inspect: true }} />
    </div>
  )
}
