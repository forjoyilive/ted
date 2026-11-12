import type { AutomationRequest, Comment, Factory, InboxItem, PlanInboxItem } from '@ted/protocol'

export interface InboxChip {
  factoryId?: string
  label: string
  count: number
}

export function waitingByFactory(
  items: readonly InboxItem[],
  questions: readonly Pick<AutomationRequest, 'factoryId'>[] = [],
  plans: readonly PlanInboxItem[] = [],
): Record<string, number> {
  const counts: Record<string, number> = {}
  const factoryIds = [
    ...items.map((i) => i.task.factoryId),
    ...questions.map((q) => q.factoryId),
    ...plans.map((p) => p.plan.factoryId),
  ]
  for (const id of factoryIds) counts[id] = (counts[id] ?? 0) + 1
  return counts
}

export function inboxChips(
  items: readonly InboxItem[],
  factories: readonly Factory[],
  questions: readonly Pick<AutomationRequest, 'factoryId'>[] = [],
  plans: readonly PlanInboxItem[] = [],
): InboxChip[] {
  const counts = waitingByFactory(items, questions, plans)
  return [
    { label: 'All', count: items.length + questions.length + plans.length },
    ...factories.map((f) => ({ factoryId: f.id, label: f.name, count: counts[f.id] ?? 0 })),
  ]
}

export function inFactory(
  items: readonly InboxItem[],
  factoryId: string | undefined,
): readonly InboxItem[] {
  return factoryId === undefined ? items : items.filter((i) => i.task.factoryId === factoryId)
}

export function nextSelection<T extends { request: { id: string } }>(
  before: readonly T[],
  now: readonly T[],
  selected: string | undefined,
): T | null | undefined {
  if (selected === undefined || now.some((i) => i.request.id === selected)) return undefined
  const at = before.findIndex((i) => i.request.id === selected)
  if (at === -1) return undefined
  const still = (item: T) => now.find((i) => i.request.id === item.request.id)
  const after = before
    .slice(at + 1)
    .map(still)
    .find((i) => i !== undefined)
  return (
    after ??
    before
      .slice(0, at)
      .reverse()
      .map(still)
      .find((i) => i !== undefined) ??
    now[0] ??
    null
  )
}

export interface InboxConfirmation {
  text: string
  detail?: string
}

export function answerConfirmation(
  request: Pick<Comment, 'kind' | 'answer' | 'permission'>,
  owner: string,
): InboxConfirmation | undefined {
  const { answer } = request
  if (!answer) return undefined
  const noun = {
    note: 'note',
    question: 'question',
    round: 'Clarify round',
    review: 'design review',
    signoff: 'sign-off',
    permission: 'permission request',
    proposal: 'proposal',
  }[request.kind]
  const target = `${owner}’s ${noun}`
  switch (answer.kind) {
    case 'approved':
      return {
        text: `Approved ${target}`,
        ...(request.permission && { detail: 'This request only' }),
        ...(answer.shutDown !== undefined && {
          detail: `Shut down ${answer.shutDown}’s simulator`,
        }),
        ...(answer.created && {
          detail: `Created ${answer.created.tasks.length} ${answer.created.tasks.length === 1 ? 'Task' : 'Tasks'}`,
        }),
      }
    case 'denied':
      return { text: `Denied ${target}` }
    case 'changes-requested':
      return { text: `Requested changes to ${target}` }
    case 'answered':
      return { text: `Answered ${target}` }
    case 'withdrawn':
    case 'superseded':
      return undefined
  }
}
