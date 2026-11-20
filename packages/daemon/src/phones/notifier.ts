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
  persisted(): Promise<void>
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
}

export function createPhoneNotifier(options: PhoneNotifierOptions): PhoneNotifier {
  const { store, presence, push } = options
  const now = options.now ?? Date.now
  const log = options.log ?? ((line: string) => console.error(line))
  const sending = new Set<Promise<void>>()
  let closed = false

  const due = (): Due[] => {
    if (closed || !presence.away() || !store.settings().notifyInboxItems) return []
    const phones = store.phones.list().flatMap((phone) => {
      const token = store.phones.pushToken(phone.id)
      return token === undefined ? [] : [{ phoneId: phone.id, token }]
    })
    if (phones.length === 0) return []
    const at = new Date(now()).toISOString()
    return store.waiting().flatMap((request) => {
      if (request.uncounted) return []
      const waitingSince = store.phones.waitingSince(request)
      return phones.flatMap((phone) =>
        store.phones.markNotified({
          phoneId: phone.phoneId,
          requestId: request.id,
          waitingSince,
          at,
        })
          ? [{ ...phone, request }]
          : [],
      )
    })
  }

  const deliver = async (item: Due) => {
    const text = pushText(item.request)
    const result = await push.send({
      to: item.token,
      title: text.title,
      body: text.body,
      requestId: item.request.id,
    })
    if (result.kind === 'unregistered' && store.phones.pushToken(item.phoneId) === item.token) {
      store.phones.clearPushToken(item.phoneId)
    }
  }

  const sendAll = async (items: Due[]) => {
    await store.persisted()
    if (closed) return
    await Promise.all(
      items.map((item) =>
        deliver(item).catch((error: Error) =>
          log(redactSecrets(`a phone notification failed: ${String(error)}`)),
        ),
      ),
    )
  }

  const update = () => {
    let items: Due[]
    try {
      items = due()
    } catch (error) {
      log(redactSecrets(`couldn’t check which phones to notify: ${String(error)}`))
      return
    }
    if (items.length === 0) return
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
