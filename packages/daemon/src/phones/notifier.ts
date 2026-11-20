import type { Banner, DaemonEvent, MachineSettings, WaitingRequest } from '@ted/protocol'
import type { Presence } from '../presence.ts'
import { redactSecrets } from '../redact.ts'
import type { PhoneStore } from '../store/index.ts'
import {
  everyFactoryTitle,
  type PhoneProblemSource,
  problemNotificationKey,
  stopsWork,
} from './problems.ts'
import type { PushMessage, PushService } from './push.ts'

export const pushTextMax = 180
export const permissionBody = 'Permission requested'

export interface PhoneNotifierStore {
  waiting(): WaitingRequest[]
  settings(): Pick<MachineSettings, 'notifyInboxItems' | 'notifyProblems'>
  phones: PhoneStore
  subscribe(listener: (event: DaemonEvent) => void): () => void
}

export interface PhoneNotifierOptions {
  store: PhoneNotifierStore
  presence: Pick<Presence, 'away' | 'leftAt' | 'subscribe'>
  push: PushService
  problems?: PhoneProblemSource
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

export function problemPushText(banner: Banner, factoryName: string | undefined): PushText {
  const place = banner.factoryId === undefined ? everyFactoryTitle : factoryName
  const title = cut(redactSecrets(place === undefined ? 'Work stopped' : `Work stopped · ${place}`))
  return { title, body: cut(redactSecrets(banner.text)) || 'A problem is stopping work' }
}

interface Due {
  phoneId: string
  token: string
  pairedAt: string
  request: WaitingRequest
  waitingSince: string
}

interface DueProblem {
  phoneId: string
  token: string
  pairedAt: string
  banner: Banner
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

  const problems = options.problems
  const away = () => !closed && presence.away()
  const open = () => away() && store.settings().notifyInboxItems
  const problemsOpen = () => problems !== undefined && away() && store.settings().notifyProblems

  const phonesWithTokens = () =>
    store.phones.list().flatMap((phone) => {
      const token = store.phones.pushToken(phone.id)
      return token === undefined ? [] : [{ phoneId: phone.id, token, pairedAt: phone.pairedAt }]
    })

  const startedWhileAway = (phone: { pairedAt: string }, startedAt: string) => {
    const left = presence.leftAt()
    if (left === undefined) return false
    const since = new Date(left).toISOString()
    return startedAt >= since && startedAt >= phone.pairedAt
  }

  const problemKeyOf = (item: Pick<DueProblem, 'phoneId' | 'banner'>) =>
    JSON.stringify([item.phoneId, problemNotificationKey(item.banner), item.banner.raisedAt])

  const problemCandidates = (): DueProblem[] => {
    if (problems === undefined || !problemsOpen()) return []
    const phones = phonesWithTokens()
    if (phones.length === 0) return []
    return stopsWork(problems).flatMap((banner) =>
      phones.flatMap((phone) => {
        const item = { ...phone, banner }
        return !startedWhileAway(phone, banner.raisedAt) ||
          inFlight.has(problemKeyOf(item)) ||
          store.phones.notified(phone.phoneId, problemNotificationKey(banner), banner.raisedAt)
          ? []
          : [item]
      }),
    )
  }

  const candidates = (): Due[] => {
    if (!open()) return []
    const phones = phonesWithTokens()
    if (phones.length === 0) return []
    return store.waiting().flatMap((request) => {
      if (request.uncounted) return []
      const waitingSince = store.phones.waitingSince(request)
      return phones.flatMap((phone) => {
        const item = { ...phone, request, waitingSince }
        return !startedWhileAway(phone, waitingSince) ||
          inFlight.has(keyOf(item)) ||
          store.phones.everNotified(phone.phoneId, request.id)
          ? []
          : [item]
      })
    })
  }

  const stillDue = (item: Due): WaitingRequest | undefined => {
    if (!open() || store.phones.pushToken(item.phoneId) !== item.token) return undefined
    if (!startedWhileAway(item, item.waitingSince)) return undefined
    if (store.phones.everNotified(item.phoneId, item.request.id)) return undefined
    const request = store.waiting().find((r) => r.id === item.request.id)
    if (request === undefined || request.uncounted) return undefined
    return store.phones.waitingSince(request) === item.waitingSince ? request : undefined
  }

  const problemStillDue = (item: DueProblem): Banner | undefined => {
    if (problems === undefined || !problemsOpen()) return undefined
    if (store.phones.pushToken(item.phoneId) !== item.token) return undefined
    if (!startedWhileAway(item, item.banner.raisedAt)) return undefined
    const key = problemNotificationKey(item.banner)
    if (store.phones.notified(item.phoneId, key, item.banner.raisedAt)) return undefined
    return stopsWork(problems).find(
      (banner) => banner.id === item.banner.id && banner.raisedAt === item.banner.raisedAt,
    )
  }

  const sendOne = async (
    phoneId: string,
    message: PushMessage,
    record: { requestId: string; waitingSince: string },
  ) => {
    const result = await push.send(message).finally(() => {
      store.phones.markNotified({ phoneId, ...record, at: new Date(now()).toISOString() })
    })
    if (result.kind === 'unregistered' && store.phones.pushToken(phoneId) === message.to) {
      store.phones.clearPushToken(phoneId)
    }
  }

  const deliver = async (item: Due) => {
    const request = stillDue(item)
    if (request === undefined) return
    const text = pushText(request)
    await sendOne(
      item.phoneId,
      { to: item.token, title: text.title, body: text.body, requestId: request.id },
      { requestId: request.id, waitingSince: item.waitingSince },
    )
  }

  const deliverProblem = async (item: DueProblem) => {
    const banner = problemStillDue(item)
    if (banner === undefined || problems === undefined) return
    const factoryName =
      banner.factoryId === undefined ? undefined : problems.factoryName(banner.factoryId)
    const text = problemPushText(banner, factoryName)
    await sendOne(
      item.phoneId,
      { to: item.token, title: text.title, body: text.body, opens: 'problems' },
      { requestId: problemNotificationKey(banner), waitingSince: banner.raisedAt },
    )
  }

  const settle = (sending: Promise<void>, key: string) =>
    sending
      .catch((error: Error) => log(redactSecrets(`a phone notification failed: ${String(error)}`)))
      .finally(() => inFlight.delete(key))

  const sendAll = async (items: Due[], problemItems: DueProblem[]) => {
    await Promise.resolve()
    await Promise.all([
      ...items.map((item) => settle(deliver(item), keyOf(item))),
      ...problemItems.map((item) => settle(deliverProblem(item), problemKeyOf(item))),
    ])
  }

  const update = () => {
    let items: Due[]
    let problemItems: DueProblem[]
    try {
      items = candidates()
      problemItems = problemCandidates()
    } catch (error) {
      log(redactSecrets(`couldn’t check which phones to notify: ${String(error)}`))
      return
    }
    if (items.length === 0 && problemItems.length === 0) return
    for (const item of items) inFlight.add(keyOf(item))
    for (const item of problemItems) inFlight.add(problemKeyOf(item))
    const running: Promise<void> = sendAll(items, problemItems)
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
  const unsubscribeProblems = problems?.subscribe((event) => {
    if (event.type === 'banner-raised' || event.type === 'banner-updated') update()
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
      unsubscribeProblems?.()
      unsubscribePresence()
    },
  }
}
