import { randomUUID } from 'node:crypto'
import type { AppRef, BrowserCommand, BrowserReply, BrowserResult } from '@ted/protocol'
import { RequestError } from '../errors.ts'

interface Pending {
  command: BrowserCommand
  sent: boolean
  cancellation?: string
  resolve: (result: BrowserResult) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export function createBrowserBroker() {
  const pending = new Map<string, Pending>()
  const canceled = new Map<string, BrowserCommand>()
  let session = ''
  let seen = 0
  let wake: (() => void) | undefined
  let polling = false
  const fail = (id: string, message: string) => {
    const item = pending.get(id)
    if (!item) return
    pending.delete(id)
    clearTimeout(item.timer)
    if (item.sent) canceled.set(id, { ...item.command, canceled: true })
    wake?.()
    item.reject(new RequestError(409, message))
  }
  const check = (owner: string, id: string, allowCanceled = false) => {
    const item = pending.get(id)
    if (owner !== session || !item?.sent || (!allowCanceled && item.cancellation))
      throw new RequestError(409, 'That browser command expired')
    return item
  }
  return {
    request(command: Omit<BrowserCommand, 'id' | 'expiresAt'>): Promise<BrowserResult> {
      if (Date.now() - seen > 12_000) {
        throw new RequestError(503, 'Open TED to use the Task browser')
      }
      if (
        pending.size >= 32 ||
        [...pending.values()].some((p) => p.command.taskId === command.taskId)
      ) {
        throw new RequestError(
          409,
          'A browser command is already running; try again when it finishes',
        )
      }
      const id = randomUUID()
      const result = new Promise<BrowserResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          fail(id, 'The browser command timed out; inspect the page before retrying')
        }, 20_000)
        pending.set(id, {
          command: { ...command, id, expiresAt: Date.now() + 20_000 },
          sent: false,
          resolve,
          reject,
          timer,
        })
      })
      wake?.()
      return result
    },
    async poll(owner: string): Promise<BrowserCommand | null> {
      if (session !== owner) {
        for (const id of pending.keys()) fail(id, 'The browser connection changed')
        canceled.clear()
        session = owner
      }
      if (polling) throw new RequestError(409, 'A browser poll is already waiting')
      polling = true
      seen = Date.now()
      try {
        if (!canceled.size && ![...pending.values()].some((p) => !p.sent)) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 5_000)
            wake = () => {
              clearTimeout(timer)
              resolve()
            }
          })
        }
        const cancellation = canceled.values().next().value
        if (cancellation) {
          canceled.delete(cancellation.id)
          return cancellation
        }
        const item = [...pending.values()].find((p) => !p.sent)
        if (!item) return null
        item.sent = true
        return item.command
      } finally {
        polling = false
        wake = undefined
        seen = Date.now()
      }
    },
    command: (owner: string, id: string) => check(owner, id).command,
    reply(owner: string, id: string, reply: BrowserReply) {
      const item = check(owner, id, true)
      if (item.cancellation && !reply.canceled) return
      pending.delete(id)
      clearTimeout(item.timer)
      if (item.cancellation) item.reject(new RequestError(409, item.cancellation))
      else if (reply.error !== undefined) item.reject(new RequestError(409, reply.error))
      else item.resolve(reply.result ?? {})
    },
    cancel(taskId: string, app?: AppRef) {
      for (const [id, item] of pending) {
        if (
          item.command.taskId === taskId &&
          (!app ||
            (item.command.app.name === app.name &&
              (app.repo === undefined || item.command.app.repo === app.repo)))
        ) {
          const message = 'The Task’s browser is no longer available'
          if (!item.sent) fail(id, message)
          else if (!item.cancellation) {
            item.cancellation = message
            canceled.set(id, { ...item.command, canceled: true })
            wake?.()
          }
        }
      }
    },
    close() {
      for (const id of pending.keys()) fail(id, 'The browser connection closed')
      seen = 0
      wake?.()
    },
  }
}
