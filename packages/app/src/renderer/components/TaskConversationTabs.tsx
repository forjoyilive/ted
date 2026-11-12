import type { ConversationTab, RunSummary, Task } from '@ted/protocol'
import { useCallback, useRef, useState } from 'react'
import type { useTaskRunsState } from '../data.ts'
import { clockTime } from '../requests.ts'
import { taskConversationTabs } from '../task-conversations.ts'
import { formatDate } from '../time.ts'
import { usePopover } from '../views/TaskList.tsx'
import { LoadingError } from './Loading.tsx'
import styles from './TaskConversationTabs.module.css'

export function TaskConversationTabs({
  task,
  runs,
  resource,
  shown,
  onShow,
  onOpen,
  onClose,
}: {
  task: Task
  runs: readonly RunSummary[]
  resource: ReturnType<typeof useTaskRunsState>
  shown: string | undefined
  onShow: (runId: string | undefined) => void
  onOpen: (runId: string) => void
  onClose: (runId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => {
    setOpen(false)
    trigger.current?.focus()
  }, [])
  const ref = usePopover(open, close)
  const earlier = runs
    .filter((run) => run.role === 'lead' && run.id !== task.leadRunId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const finished = runs
    .filter((run) => run.role === 'sub-agent' && run.state === 'finished')
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const leadIds = new Set(earlier.map((run) => run.id))
  const tabs = taskConversationTabs(task, shown).filter((tab) => !leadIds.has(tab.runId))
  const isLead = shown === undefined || shown === task.leadRunId || leadIds.has(shown)
  const openHistory = (runId: string) => {
    setOpen(false)
    trigger.current?.focus()
    onOpen(runId)
  }
  const historyRows = (list: readonly RunSummary[]) =>
    list.map((run) => (
      <button
        key={run.id}
        type="button"
        className={styles.historyRow}
        data-nav-item
        onClick={() => openHistory(run.id)}
      >
        <span>{run.role === 'lead' ? 'Earlier conversation' : run.name}</span>
        <small>
          {formatDate(run.startedAt, { day: 'numeric', month: 'short', year: 'numeric' })} ·{' '}
          {clockTime(run.startedAt)} · {run.agent === 'claude' ? 'Claude' : 'Codex'}
        </small>
      </button>
    ))
  return (
    <div className={styles.bar}>
      <div className={styles.tabs} role="tablist" aria-label="Task Lead and sub-agents">
        <button
          type="button"
          role="tab"
          aria-selected={isLead}
          className={styles.tab}
          onClick={() => onShow(undefined)}
        >
          Task Lead
        </button>
        {tabs.map((tab: ConversationTab) => (
          <span key={tab.runId} className={styles.tabWrap}>
            <button
              type="button"
              role="tab"
              aria-selected={shown === tab.runId}
              className={styles.tab}
              onClick={() => onOpen(tab.runId)}
            >
              <span
                className={styles.dot}
                data-state={tab.state}
                role="img"
                aria-label={tab.state}
              />
              {tab.name}
            </button>
            {tab.state === 'finished' && (
              <button
                type="button"
                className={styles.close}
                aria-label={`Close ${tab.name}`}
                onClick={() => onClose(tab.runId)}
              >
                ×
              </button>
            )}
          </span>
        ))}
      </div>
      <div ref={ref} className={styles.history}>
        <button
          ref={trigger}
          type="button"
          className={styles.historyButton}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          History{earlier.length + finished.length > 0 && ` · ${earlier.length + finished.length}`}
        </button>
        {open && (
          <section className={styles.menu} aria-label="Conversation history">
            <h2>History</h2>
            {resource.error && <LoadingError error={resource.error} retry={resource.retry} />}
            {resource.value === undefined && !resource.error && <p>Loading history…</p>}
            {earlier.length > 0 && (
              <>
                <h3>Earlier conversations</h3>
                <p>A Task has one Task Lead. These conversations ended before this one started.</p>
                {historyRows(earlier)}
              </>
            )}
            {finished.length > 0 && (
              <>
                <h3>Finished sub-agents</h3>
                {historyRows(finished)}
              </>
            )}
            {resource.value !== undefined &&
              !resource.error &&
              earlier.length + finished.length === 0 && (
                <p>No earlier conversations or finished sub-agents yet.</p>
              )}
          </section>
        )}
      </div>
    </div>
  )
}
