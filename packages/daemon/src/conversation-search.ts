import { setImmediate } from 'node:timers/promises'
import {
  type ChatItem,
  type ConversationHit,
  matchesTerms,
  planTitle,
  searchLimits,
  searchTerms,
  snippetAround,
  type Task,
} from '@ted/protocol'
import type { Conversations } from './runs/conversations.ts'
import type { SearchRequest } from './search.ts'
import type { TedStore } from './store/index.ts'

function itemText(item: ChatItem): string | undefined {
  if (item.kind === 'agent' || item.kind === 'human') return item.text
  if (item.kind !== 'tool') return undefined
  return [
    item.tool,
    item.title,
    item.detail,
    ...(item.diffs ?? []).flatMap((diff) => [diff.path, ...diff.lines.map((line) => line.text)]),
    ...((item.diffs?.length ?? 0) === 0 || item.status === 'failed' ? [item.output] : []),
  ]
    .filter((text) => text !== undefined)
    .join('\n')
}

export async function searchConversations(
  store: TedStore,
  conversations: Pick<Conversations, 'chat'>,
  { query, factoryId }: SearchRequest,
  everyTask?: readonly Task[],
): Promise<ConversationHit[]> {
  const terms = searchTerms(query)
  if (terms.length === 0) return []
  const factories = new Set(store.listFactories().map((factory) => factory.id))
  const tasks = new Map((everyTask ?? store.listTasks()).map((task) => [task.id, task]))
  const plans = new Map(store.plans.list().map((plan) => [plan.id, plan]))
  const automations = new Map(
    store.automations.list().map((automation) => [automation.id, automation]),
  )
  const firings = new Map(store.automations.firings().map((firing) => [firing.id, firing]))
  const coordinators = new Map(
    store.coordinators.list().flatMap((c) => c.runIds.map((id) => [id, c] as const)),
  )
  const hits: ConversationHit[] = []
  const compare = (a: ConversationHit, b: ConversationHit) =>
    Number(b.factoryId === factoryId) - Number(a.factoryId === factoryId) ||
    b.at.localeCompare(a.at) ||
    a.runId.localeCompare(b.runId) ||
    a.itemId.localeCompare(b.itemId)

  for (const run of store.listRuns()) {
    const task = run.taskId === undefined ? undefined : tasks.get(run.taskId)
    const plan = plans.get(run.id)
    const firing = firings.get(run.id)
    const automation = firing && automations.get(firing.automationId)
    const coordinator = coordinators.get(run.id)
    const owner = task
      ? {
          source: 'task' as const,
          factoryId: task.factoryId,
          ref: task.displayId,
          title: task.title,
        }
      : run.taskId !== undefined
        ? undefined
        : plan
          ? { source: 'plan' as const, factoryId: plan.factoryId, ref: 'Plan', title: plan.title }
          : automation
            ? {
                source: 'automation' as const,
                factoryId: automation.factoryId,
                ref: 'Automation',
                title: automation.name,
              }
            : coordinator !== undefined
              ? {
                  source: 'coordinator' as const,
                  factoryId: coordinator.factoryId,
                  chatId: coordinator.id,
                  ref: 'Coordinator',
                  title: coordinator.title ?? (planTitle(coordinator.opening) || 'Coordinator'),
                }
              : undefined
    if (!owner || !factories.has(owner.factoryId)) continue
    await setImmediate()
    if (!store.getRun(run.id)) continue
    const chat = await conversations.chat(run.id)
    const found: ConversationHit[] = []
    for (const item of chat.items) {
      const text = itemText(item)
      if (text === undefined || !matchesTerms(terms, text)) continue
      if (item.kind !== 'agent' && item.kind !== 'human' && item.kind !== 'tool') continue
      found.push({
        ...owner,
        runId: run.id,
        itemId: item.id,
        runName: chat.run.name,
        kind: item.kind,
        at: item.at ?? run.startedAt,
        snippet: snippetAround(terms, text),
      })
      found.sort(compare)
      found.splice(searchLimits.conversationsPerRun)
    }
    hits.push(...found)
    hits.sort(compare)
    hits.splice(searchLimits.conversations)
  }
  return hits
}
