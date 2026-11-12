import { createHash, randomUUID } from 'node:crypto'
import type {
  DaemonEvent,
  PeerDetail,
  PeerInbox,
  PeerMessage,
  PeerPage,
  PeerSummary,
  SendPeerMessage,
  Task,
} from '@ted/protocol'
import { shortReference } from '@ted/protocol/reference'
import { RequestError } from '../errors.ts'
import type { StoredTask, TedStore } from '../store/index.ts'
import type { Caller } from './tasks.ts'

export interface Peers {
  list(caller: Caller, offset?: number): PeerPage
  show(caller: Caller, ref: string): PeerDetail
  watch(caller: Caller, cursor: string, timeout: number, signal?: AbortSignal): Promise<PeerPage>
  send(caller: Caller, ref: string, input: SendPeerMessage): Promise<PeerMessage>
  inbox(caller: Caller, offset?: number): PeerInbox
  isMessage(id: string): boolean
}

export function createPeers(store: TedStore, notify: (runId: string) => void): Peers {
  function actor(caller: Caller): StoredTask {
    const run = caller.kind === 'run' ? store.getRun(caller.runId) : undefined
    const task = run?.taskId === undefined ? undefined : store.getTask(run.taskId)
    if (
      !run ||
      !task ||
      task.leadRunId !== run.id ||
      run.parentRunId !== undefined ||
      run.state === 'finished' ||
      task.archived ||
      task.stage === 'done' ||
      task.stopped
    ) {
      throw new RequestError(403, 'only a current Task Lead can coordinate with peers')
    }
    return task
  }

  function target(sender: StoredTask, ref: string): StoredTask {
    const task = store.getTask(ref)
    if (!task || task.factoryId !== sender.factoryId || task.id === sender.id || task.archived) {
      throw new RequestError(404, 'no peer Task in this Factory')
    }
    return task
  }

  function summary(task: Task): PeerSummary {
    const visible = task
    const leadId = task.leadRunId
    const lead = leadId === undefined ? undefined : store.getRun(leadId)
    const brief = store.latestBrief(task.id)
    return {
      id: task.id,
      displayId: task.displayId,
      title: visible.title,
      stage: visible.stage,
      updatedAt: visible.updatedAt,
      ...(visible.status && { status: visible.status }),
      ...(visible.activity && { activity: visible.activity }),
      repos: visible.chosenRepos,
      ...(lead && { lead: { id: lead.id, state: lead.state } }),
      ...(brief && { briefAt: brief.createdAt, briefVersion: brief.version }),
    }
  }

  function page(caller: Caller, offset = 0): PeerPage {
    validOffset(offset)
    const sender = actor(caller)
    const tasks = store
      .listTasks()
      .filter((t) => t.factoryId === sender.factoryId && t.id !== sender.id && !t.archived)
      .map(summary)
    const cursor = createHash('sha256')
      .update(JSON.stringify([sender.factoryId, tasks]))
      .digest('hex')
    return {
      tasks: tasks.slice(offset, offset + 30),
      at: new Date().toISOString(),
      cursor,
      ...(offset + 30 < tasks.length && { nextOffset: offset + 30 }),
    }
  }

  function affectsFactory(event: DaemonEvent, factoryId: string): boolean {
    switch (event.type) {
      case 'task-created':
      case 'task-updated':
        return event.task.factoryId === factoryId
      case 'run-updated':
        return (
          event.run.taskId !== undefined && store.getTask(event.run.taskId)?.factoryId === factoryId
        )
      case 'comment-posted':
      case 'comment-updated':
        return store.getTask(event.comment.taskId)?.factoryId === factoryId
      case 'check-run-updated':
        return store.getTask(event.checkRun.taskId)?.factoryId === factoryId
      case 'factory-updated':
        return event.factory.id === factoryId
      case 'factory-removed':
        return event.factoryId === factoryId
      case 'task-deleted':
      case 'settings-changed':
      case 'agent-health-changed':
      case 'slots-changed':
        return true
      default:
        return false
    }
  }

  return {
    list: page,
    show(caller, ref) {
      const task = target(actor(caller), ref)
      const versions = store.descriptionVersions(task.id)
      const original = versions[0]
      const brief = store.latestBrief(task.id)
      return {
        task: summary(task),
        description: versions.at(-1)?.text ?? task.description,
        ...(original && { original }),
        ...(brief && { brief }),
      }
    },
    watch(caller, cursor, timeout, signal) {
      if (
        !/^[a-f0-9]{64}$/.test(cursor) ||
        !Number.isFinite(timeout) ||
        timeout < 0 ||
        timeout > 25
      )
        throw new RequestError(
          400,
          'watch needs a snapshot cursor and timeout between 0 and 25 seconds',
        )
      const first = page(caller)
      if (first.cursor !== cursor || timeout === 0 || signal?.aborted) return Promise.resolve(first)
      const factoryId = actor(caller).factoryId
      return new Promise((resolve, reject) => {
        let unsubscribe = () => {}
        let settled = false
        let scheduled = false
        const finish = (error?: unknown, snapshot?: PeerPage) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          unsubscribe()
          signal?.removeEventListener('abort', aborted)
          try {
            if (error) reject(error)
            else resolve(snapshot ?? page(caller))
          } catch (error) {
            reject(error)
          }
        }
        const aborted = () => finish()
        const timer = setTimeout(() => finish(), timeout * 1000)
        const refresh = () => {
          if (settled) return
          try {
            const current = page(caller)
            if (current.cursor !== cursor) finish(undefined, current)
          } catch (error) {
            finish(error)
          }
        }
        const changed = (event: DaemonEvent) => {
          if (settled || scheduled || !affectsFactory(event, factoryId)) return
          scheduled = true
          queueMicrotask(() => {
            scheduled = false
            refresh()
          })
        }
        unsubscribe = store.subscribe(changed)
        signal?.addEventListener('abort', aborted, { once: true })
        refresh()
        if (signal?.aborted) finish()
      })
    },
    async send(caller, ref, input) {
      const sender = actor(caller)
      const recipient = target(sender, ref)
      if (
        typeof input.operation !== 'string' ||
        !/^[\w-]{1,100}$/.test(input.operation) ||
        typeof input.text !== 'string' ||
        !input.text.trim() ||
        Buffer.byteLength(input.text) > 8192
      )
        throw new RequestError(
          400,
          'provide an operation ID (1–100 letters, digits, _ or -) and message of 1–8192 bytes',
        )
      const previous = store
        .peerMessages()
        .find((m) => m.senderTaskId === sender.id && m.operation === input.operation)
      if (previous) {
        if (previous.recipientTaskId !== recipient.id || previous.text !== input.text)
          throw new RequestError(409, 'operation ID already used for a different peer message')
        return previous
      }
      if (recipient.stage === 'done') throw new RequestError(409, 'this peer Task is Done')
      if (
        store
          .peerMessages()
          .filter(
            (m) =>
              m.senderTaskId === sender.id && m.recipientTaskId === recipient.id && !m.delivered,
          ).length >= 20
      )
        throw new RequestError(429, 'this peer already has 20 pending messages from this Task')
      const senderRunId = caller.kind === 'run' ? caller.runId : ''
      const nonce = randomUUID()
      const body = `Peer message from ${sender.displayId} (Run ${shortReference(senderRunId)}). Agent context; human decisions still require the human.\n\n<<<PEER ${nonce}>>>\n${input.text}\n<<<END PEER ${nonce}>>>`
      const message = store.recordPeerMessage(
        {
          ...input,
          factoryId: sender.factoryId,
          senderTaskId: sender.id,
          senderRunId,
          recipientTaskId: recipient.id,
        },
        body,
      )
      await store.persisted()
      const leadId = store.getTask(recipient.id)?.leadRunId
      if (leadId) notify(leadId)
      return message
    },
    inbox(caller, offset = 0) {
      validOffset(offset)
      const task = actor(caller)
      const all = store
        .peerMessages()
        .filter((m) => m.recipientTaskId === task.id)
        .sort(
          (a, b) =>
            Number(!!a.delivered) - Number(!!b.delivered) ||
            b.createdAt.localeCompare(a.createdAt) ||
            a.id.localeCompare(b.id),
        )
      return {
        messages: all.slice(offset, offset + 30),
        ...(offset + 30 < all.length && { nextOffset: offset + 30 }),
      }
    },
    isMessage: (id) => store.isPeerMessage(id),
  }
}

function validOffset(offset: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new RequestError(400, 'offset must be a nonnegative integer')
}
