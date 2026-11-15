import type { AgentStageId, Comment, RunChat, RunSummary, StageEntry } from '@ted/protocol'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { clockTime } from '../requests.ts'
import { conversationInStage } from '../task-conversations.ts'
import { formatDate } from '../time.ts'
import column from './ChatColumn.module.css'
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
  sideChatFor,
  onSideChatOpened,
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
  sideChatFor?: string | undefined
  onSideChatOpened?: (() => void) | undefined
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
          className={`${styles.items} ${column.list}`}
        >
          {earlier.map((run) => (
            <EarlierConversation
              key={run.id}
              run={run}
              reveal={conversationTarget === `conversation:${run.id}` ? revealRun : undefined}
              openSideChat={sideChatFor === run.id}
              onSideChatOpened={onSideChatOpened}
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
  return (
    <RunWithSideChat
      runId={leadRunId}
      bar={false}
      openSideChat={leadRunId !== undefined && sideChatFor === leadRunId}
      onSideChatOpened={onSideChatOpened}
      renderSource={(resource) => body(resource.value, resource.error, resource.retry)}
    />
  )
}

function EarlierConversation({
  run,
  reveal,
  openSideChat,
  onSideChatOpened,
  comments,
  entries,
  stage,
}: {
  run: RunSummary
  reveal: string | ScrollReveal | undefined
  openSideChat: boolean
  onSideChatOpened: (() => void) | undefined
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
  useEffect(() => {
    if (openSideChat) setOpen(true)
  }, [openSideChat])
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
        <EarlierMessages
          runId={run.id}
          openSideChat={openSideChat}
          onSideChatOpened={onSideChatOpened}
          comments={comments}
          entries={entries}
          stage={stage}
        />
      )}
    </details>
  )
}

function EarlierMessages({
  runId,
  openSideChat,
  onSideChatOpened,
  comments,
  entries,
  stage,
}: {
  runId: string
  openSideChat: boolean
  onSideChatOpened: (() => void) | undefined
  comments: readonly Comment[]
  entries: readonly StageEntry[]
  stage: AgentStageId | undefined
}) {
  return (
    <RunWithSideChat
      runId={runId}
      bar={false}
      openSideChat={openSideChat}
      onSideChatOpened={onSideChatOpened}
      renderSource={(resource) => (
        <div className={`${styles.olderItems} ${column.nested}`}>
          {resource.error && <LoadingError error={resource.error} retry={resource.retry} />}
          {!resource.value && !resource.error && (
            <Skeleton shape="history" label="Loading earlier conversation…" />
          )}
          <ChatTimeline
            chat={visibleChat(resource.value, comments, entries, stage)}
            options={{ inspect: true }}
          />
        </div>
      )}
    />
  )
}
