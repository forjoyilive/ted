import type { ChatArchiveExpiry } from '@ted/protocol'
import type { Coordinators } from './coordinators/coordinators.ts'
import type { Plans } from './plans/plans.ts'
import { redactSecrets } from './redact.ts'
import type { TedStore } from './store/index.ts'

const dayMs = 24 * 60 * 60 * 1000

export interface ArchivedChat {
  agent: 'coordinator' | 'planner'
  id: string
  archivedAt: string
}

export function chatsDue(chats: readonly ArchivedChat[], days: number, now: Date): ArchivedChat[] {
  const cutoff = now.getTime() - days * dayMs
  return chats.filter((chat) => Date.parse(chat.archivedAt) < cutoff)
}

export function archivedChats(
  store: Pick<TedStore, 'listFactories' | 'coordinators' | 'plans'>,
): ArchivedChat[] {
  const factories = new Set(store.listFactories().map((f) => f.id))
  const coordinators = [...factories].flatMap((factoryId) =>
    store.coordinators
      .chats(factoryId)
      .flatMap((chat): ArchivedChat[] =>
        chat.endedAt === undefined
          ? []
          : [{ agent: 'coordinator', id: chat.id, archivedAt: chat.endedAt }],
      ),
  )
  const plans = store.plans
    .list()
    .flatMap((plan): ArchivedChat[] =>
      plan.archivedAt === undefined || !factories.has(plan.factoryId)
        ? []
        : [{ agent: 'planner', id: plan.id, archivedAt: plan.archivedAt }],
    )
  return [...coordinators, ...plans]
}

export interface ChatArchiveCleanup {
  preview(days: number): ChatArchiveExpiry
  sweep(): Promise<void>
  close(): Promise<void>
}

export function createChatArchiveCleanup(options: {
  store: Pick<TedStore, 'listFactories' | 'coordinators' | 'plans' | 'settings'>
  plans: Pick<Plans, 'delete'>
  coordinators: Pick<Coordinators, 'deleteChat'>
  now?: () => Date
}): ChatArchiveCleanup {
  const now = options.now ?? (() => new Date())
  let sweeping: Promise<void> | undefined
  let again = false
  let closed = false

  async function sweepOnce(): Promise<void> {
    const failed = new Set<string>()
    while (!closed) {
      const days = options.store.settings().deleteArchivedChatsAfterDays
      if (days === null) return
      const next = chatsDue(archivedChats(options.store), days, now()).find(
        (chat) => !failed.has(chat.id),
      )
      if (!next) return
      try {
        if (next.agent === 'planner') await options.plans.delete(next.id, { kind: 'app' })
        else await options.coordinators.deleteChat(next.id)
        console.log(`deleted archived ${next.agent} chat ${next.id} (archived ${next.archivedAt})`)
      } catch (error) {
        failed.add(next.id)
        console.error(
          redactSecrets(`couldn’t delete archived ${next.agent} chat ${next.id}: ${String(error)}`),
        )
      }
    }
  }

  return {
    preview(days) {
      return { due: chatsDue(archivedChats(options.store), days, now()).length }
    },
    sweep() {
      if (closed) return Promise.resolve()
      if (sweeping) {
        again = true
        return sweeping
      }
      sweeping = (async () => {
        do {
          again = false
          await sweepOnce()
        } while (again && !closed)
      })().finally(() => {
        sweeping = undefined
      })
      return sweeping
    },
    async close() {
      closed = true
      await sweeping?.catch(() => undefined)
    },
  }
}
