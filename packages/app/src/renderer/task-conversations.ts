import type { ChatItem, ConversationTab, Task } from '@ted/protocol'

export { conversationRows } from '@ted/protocol/agent-chat-view'

type TabTask = Pick<Task, 'tabs'> & Partial<Pick<Task, 'runs' | 'leadRunId'>>

export function taskConversationTabs(task: TabTask, selected?: string): ConversationTab[] {
  const live = (task.runs ?? []).filter(
    (run) => run.role === 'sub-agent' && (run.state !== 'finished' || run.id === selected),
  )
  const tabs = new Map<string, ConversationTab>(
    live.map((run) => [
      run.id,
      { runId: run.id, name: run.name, agent: run.agent, state: run.state },
    ]),
  )
  for (const tab of task.tabs) {
    const run = task.runs?.find((run) => run.id === tab.runId)
    if (tab.runId === task.leadRunId || run?.role === 'lead') continue
    if (tab.state !== 'finished' || tab.runId === selected) tabs.set(tab.runId, tab)
  }
  return [...tabs.values()]
}

export function conversationInStage(
  items: readonly ChatItem[],
  startedAt: string,
  entries: readonly { stage: string; at: string }[],
  stage: string | undefined,
): ChatItem[] {
  let at = startedAt
  return items.filter((item) => {
    if (item.at !== undefined) at = item.at
    if (stage === undefined) return true
    return entries.some(
      (entry, index) =>
        entry.stage === stage &&
        at >= entry.at &&
        (entries[index + 1] === undefined || at < (entries[index + 1]?.at ?? '')),
    )
  })
}
