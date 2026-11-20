import type { DaemonEvent, MachineSettings, WaitingRequest } from '@ted/protocol'
import type { Presence } from '../presence.ts'
import { redactSecrets } from '../redact.ts'
import type { PhoneStore } from '../store/index.ts'
import type { PushService } from './push.ts'

export const pushTextMax = 180
export const permissionBody = 'Permission requested'

export interface PhoneNotifierStore {
  waiting(): WaitingRequest[]
  settings(): Pick<MachineSettings, 'notifyInboxItems'>
  phones: PhoneStore
  subscribe(listener: (event: DaemonEvent) => void): () => void
}

export interface PhoneNotifierOptions {
  store: PhoneNotifierStore
  presence: Pick<Presence, 'away' | 'subscribe'>
  push: PushService
  now?: () => number
  log?: (line: string) => void
}

export interface PhoneNotifier {
  idle(): Promise<void>
  close(): void
}

function cut(text: string): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()]
  return chars.length <= pushTextMax
    ? chars.join('')
    : `${chars.slice(0, pushTextMax - 1).join('')}…`
}

function titleOf(request: WaitingRequest): string {
  switch (request.source) {
    case 'task':
      return request.taskTitle
    case 'plan':
      return request.planTitle
    case 'automation':
      return request.automationName
    default:
      return request.chatTitle
  }
}

function asksPermission(request: WaitingRequest): boolean {
  if (request.source === 'task' || request.source === 'plan') return request.kind === 'permission'
  if (request.source === 'coordinator') return request.requestKind === 'outside-command'
  return false
}

export interface PushText {
  title: string
  body: string
}

export function pushText(request: WaitingRequest): PushText {
  const title = cut(redactSecrets(titleOf(request))) || 'Ted'
  const body = asksPermission(request) ? permissionBody : cut(redactSecrets(request.headline))
  return { title, body: body || 'Ted needs your answer' }
}

interface Due {
  phoneId: string
  token: string
  request: WaitingRequest
  waitingSince: string
}

export function createPhoneNotifier(options: PhoneNotifierOptions): PhoneNotifier {
  const { store, presence, push } = options
  const now = options.now ?? Date.now
  const log = options.log ?? ((line: string) => console.error(line))
  const sending = new Set<Promise<void>>()
  const inFlight = new Set<string>()
  let closed = false

  const keyOf = (item: Pick<Due, 'phoneId' | 'request' | 'waitingSince'>) =>
    JSON.stringify([item.phoneId, item.request.id, item.waitingSince])

  const open = () => !closed && presence.away() && store.settings().notifyInboxItems

  const candidates = (): Due[] => {
    if (!open()) return []
    const phones = store.phones.list().flatMap((phone) => {
      const token = store.phones.pushToken(phone.id)
      return token === undefined ? [] : [{ phoneId: phone.id, token }]
    })
    if (phones.length === 0) return []
    return store.waiting().flatMap((request) => {
      if (request.uncounted) return []
      const waitingSince = store.phones.waitingSince(request)
      return phones.flatMap((phone) => {
        const item = { ...phone, request, waitingSince }
        return inFlight.has(keyOf(item)) ||
          store.phones.notified(phone.phoneId, request.id, waitingSince)
          ? []
          : [item]
      })
    })
  }

  const stillDue = (item: Due): WaitingRequest | undefined => {
    if (!open() || store.phones.pushToken(item.phoneId) !== item.token) return undefined
    if (store.phones.notified(item.phoneId, item.request.id, item.waitingSince)) return undefined
    const request = store.waiting().find((r) => r.id === item.request.id)
    if (request === undefined || request.uncounted) return undefined
    return store.phones.waitingSince(request) === item.waitingSince ? request : undefined
  }

  const deliver = async (item: Due) => {
    const request = stillDue(item)
    if (request === undefined) return
    const text = pushText(request)
    const sent = push.send({
      to: item.token,
      title: text.title,
      body: text.body,
      requestId: request.id,
    })
    const result = await sent.finally(() => {
      store.phones.markNotified({
        phoneId: item.phoneId,
        requestId: request.id,
        waitingSince: item.waitingSince,
        at: new Date(now()).toISOString(),
      })
    })
    if (result.kind === 'unregistered' && store.phones.pushToken(item.phoneId) === item.token) {
      store.phones.clearPushToken(item.phoneId)
    }
  }

  const sendAll = async (items: Due[]) => {
    await Promise.resolve()
    await Promise.all(
      items.map((item) =>
        deliver(item)
          .catch((error: Error) =>
            log(redactSecrets(`a phone notification failed: ${String(error)}`)),
          )
          .finally(() => inFlight.delete(keyOf(item))),
      ),
    )
  }

  const update = () => {
    let items: Due[]
    try {
      items = candidates()
    } catch (error) {
      log(redactSecrets(`couldn’t check which phones to notify: ${String(error)}`))
      return
    }
    if (items.length === 0) return
    for (const item of items) inFlight.add(keyOf(item))
    const running: Promise<void> = sendAll(items)
      .catch((error: Error) => log(redactSecrets(`phone notifications failed: ${String(error)}`)))
      .finally(() => sending.delete(running))
    sending.add(running)
  }

  const unsubscribeStore = store.subscribe((event) => {
    if (
      event.type === 'inbox-changed' ||
      event.type === 'settings-changed' ||
      event.type === 'phones-changed'
    )
      update()
  })
  const unsubscribePresence = presence.subscribe(() => update())
  update()

  return {
    async idle() {
      while (sending.size > 0) await Promise.all([...sending])
    },
    close() {
      closed = true
      unsubscribeStore()
      unsubscribePresence()
    },
  }
}
