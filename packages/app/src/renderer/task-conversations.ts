import type { ChatItem, ConversationTab, Task } from '@ted/protocol'

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

export function conversationRows<T extends { at: string }>(
  items: readonly ChatItem[],
  extra: readonly T[],
  startedAt: string,
): ({ item: ChatItem } | { extra: T })[] {
  let lastAt = startedAt
  const rows = items.map((item) => {
    if (item.at !== undefined && item.at > lastAt) lastAt = item.at
    return { item, at: lastAt, queued: item.kind === 'human' && item.queued === true }
  })
  const additions = [...extra].sort((a, b) => a.at.localeCompare(b.at))
  const merged: ({ item: ChatItem } | { extra: T })[] = []
  let index = 0
  for (const row of rows) {
    while (index < additions.length) {
      const added = additions[index]
      if (!added || (!row.queued && added.at >= row.at)) break
      merged.push({ extra: added })
      index++
    }
    merged.push({ item: row.item })
  }
  for (const added of additions.slice(index)) merged.push({ extra: added })
  return merged
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
