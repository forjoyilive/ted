import type { ConversationTab, RunSummary, Task } from '@ted/protocol'
import { taskConversationTabs } from '../task-conversations.ts'
import { ActionButton } from './ActionButton.tsx'
import styles from './TaskConversationTabs.module.css'

export function TaskConversationTabs({
  task,
  runs,
  shown,
  onShow,
  onOpen,
  onClose,
}: {
  task: Task
  runs: readonly RunSummary[]
  shown: string | undefined
  onShow: (runId: string | undefined) => void
  onOpen: (runId: string) => unknown
  onClose: (runId: string) => void
}) {
  const earlier = runs.filter((run) => run.role === 'lead' && run.id !== task.leadRunId)
  const leadIds = new Set(earlier.map((run) => run.id))
  const tabs = taskConversationTabs(task, shown).filter((tab) => !leadIds.has(tab.runId))
  const isLead = shown === undefined || shown === task.leadRunId || leadIds.has(shown)
  if (tabs.length === 0 && shown === undefined) return null
  return (
    <div className={styles.bar}>
      <div className={styles.tabs} role="tablist" aria-label="Task Lead and sub-agents">
        <ActionButton
          type="button"
          role="tab"
          aria-selected={isLead}
          className={styles.tab}
          onClick={() => onShow(undefined)}
        >
          Task Lead
        </ActionButton>
        {tabs.map((tab: ConversationTab) => (
          <span key={tab.runId} className={styles.tabWrap}>
            <ActionButton
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
            </ActionButton>
            {tab.state === 'finished' && (
              <ActionButton
                type="button"
                className={styles.close}
                aria-label={`Close ${tab.name}`}
                onClick={() => onClose(tab.runId)}
              >
                ×
              </ActionButton>
            )}
          </span>
        ))}
      </div>
    </div>
  )
}
