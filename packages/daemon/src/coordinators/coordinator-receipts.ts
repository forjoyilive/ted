import type { CoordinatorReceipt, CoordinatorRemovalResult, Task } from '@ted/protocol'
import { RequestError } from '../errors.ts'
import { redactSecrets } from '../redact.ts'
import type { StoredCoordinator } from '../store/coordinators.ts'

const tasksRemembered = 100

const notSaved = 'Action interrupted before its result was saved.'
export const interrupted = {
  task: `${notSaved} Check the Task’s current state before deciding what to do next.`,
  factory: `${notSaved} Read the Factory’s Tasks before deciding what to do next.`,
}

export const remembered = (taskIds: readonly string[], ids: readonly string[]) =>
  [...new Set([...taskIds, ...ids])].slice(-tasksRemembered)

export interface ReceiptStore {
  chat(id: string): StoredCoordinator
  save(chat: StoredCoordinator): void
  persisted(): Promise<void>
  task(id: string): Task | undefined
  snapshot(task: Task): NonNullable<CoordinatorReceipt['before']>
}

export interface ReceiptStart {
  id: string
  operation: CoordinatorReceipt['operation']
  fingerprint: string
  task?: Task
}

export interface Recorded {
  receipt: CoordinatorReceipt
  done: boolean
  error?: Error
}

export function coordinatorReceipts(store: ReceiptStore) {
  const chains = new Map<string, Promise<unknown>>()
  const refuse = () => {
    throw new RequestError(409, 'operation ID already used for another action')
  }
  const withTask = (chat: StoredCoordinator, taskId: string | undefined) =>
    taskId === undefined ? {} : { taskIds: remembered(chat.taskIds, [taskId]) }

  async function rewrite(chatId: string, receipt: CoordinatorReceipt): Promise<void> {
    receipt.text = redactSecrets(receipt.text)
    const latest = store.chat(chatId)
    store.save({
      ...latest,
      receipts: latest.receipts.map((r) => (r.id === receipt.id ? receipt : r)),
      ...withTask(latest, receipt.taskId),
    })
    await store.persisted()
  }

  return {
    serial<T>(factoryId: string, work: () => Promise<T>): Promise<T> {
      const next = (chains.get(factoryId) ?? Promise.resolve()).catch(() => {}).then(work)
      chains.set(factoryId, next)
      return next.finally(() => {
        if (chains.get(factoryId) === next) chains.delete(factoryId)
      })
    },
    async settled(factoryId: string): Promise<void> {
      await chains.get(factoryId)?.catch(() => {})
    },
    queued: (): Promise<unknown>[] => [...chains.values()],

    replay(
      chat: StoredCoordinator,
      operation: string,
      fingerprint: string,
    ): CoordinatorReceipt | undefined {
      const old = chat.receipts.find((r) => r.id === operation)
      if (old && old.fingerprint !== fingerprint) refuse()
      return old
    },

    replayGroup(
      chat: StoredCoordinator,
      operation: string,
      fingerprint: string,
    ): CoordinatorRemovalResult | undefined {
      const prefix = `${operation}:`
      const earlier = chat.receipts.filter((r) => r.id.startsWith(prefix))
      const asked = (chat.confirmations ?? []).find((x) => x.operation === operation)
      const used = asked?.fingerprint ?? earlier[0]?.fingerprint
      if (used !== undefined) {
        if (used !== fingerprint) refuse()
        return {
          receipts: earlier,
          ...(asked && { confirmation: { id: asked.id, waiting: asked.answer === undefined } }),
        }
      }
      if (chat.receipts.some((r) => r.id === operation)) refuse()
      return undefined
    },

    async record(
      chatId: string,
      start: ReceiptStart,
      work: (receipt: CoordinatorReceipt) => Promise<string>,
      failed: (error: Error, receipt: CoordinatorReceipt) => string,
    ): Promise<Recorded> {
      const { task } = start
      const receipt: CoordinatorReceipt = {
        id: start.id,
        operation: start.operation,
        ...(task && { taskId: task.id }),
        text: task ? interrupted.task : interrupted.factory,
        at: new Date().toISOString(),
        fingerprint: start.fingerprint,
        ...(task && { before: store.snapshot(task) }),
      }
      const opened = store.chat(chatId)
      store.save({
        ...opened,
        receipts: [...opened.receipts, receipt],
        ...withTask(opened, receipt.taskId),
      })
      await store.persisted()
      let result: Recorded
      try {
        receipt.text = await work(receipt)
        result = { receipt, done: true }
      } catch (thrown) {
        const error = thrown instanceof Error ? thrown : new Error(String(thrown))
        receipt.text = failed(error, receipt)
        result = { receipt, done: false, error }
      }
      const after = receipt.taskId === undefined ? undefined : store.task(receipt.taskId)
      if (after) receipt.after = store.snapshot(after)
      await rewrite(chatId, receipt)
      return result
    },

    rewrite,

    async append(chatId: string, receipt: CoordinatorReceipt): Promise<void> {
      receipt.text = redactSecrets(receipt.text)
      const latest = store.chat(chatId)
      store.save({
        ...latest,
        receipts: [...latest.receipts, receipt],
        ...withTask(latest, receipt.taskId),
      })
      await store.persisted()
    },
  }
}

export type CoordinatorReceipts = ReturnType<typeof coordinatorReceipts>
