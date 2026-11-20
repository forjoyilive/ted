import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Banner, WaitingRequest } from '@ted/protocol'
import { afterEach, beforeEach, expect, expectTypeOf, test, vi } from 'vitest'
import {
  createPhoneNotifier,
  type PhoneNotifier,
  permissionBody,
  problemPushText,
  pushText,
  pushTextMax,
} from '../src/phones/notifier.ts'
import type { PhoneProblemSource } from '../src/phones/problems.ts'
import type { PushMessage, PushResult, PushService } from '../src/phones/push.ts'
import { createPresence, type Presence } from '../src/presence.ts'
import { openStore, type PhonesArea, type TedStore } from '../src/store/index.ts'

expectTypeOf<TedStore>().toExtend<PhonesArea>()

const token = 'ExponentPushToken[phone-one]'
const otherToken = 'ExponentPushToken[phone-two]'

let directory: string
let store: TedStore
let factoryId: string
let presence: Presence
let notifier: PhoneNotifier | undefined
let sent: PushMessage[]
let answerWith: (message: PushMessage) => PushResult

const push: PushService = {
  async send(message) {
    sent.push(message)
    return answerWith(message)
  },
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'ted-phone-notifier-'))
  store = await openStore({ directory })
  factoryId = store.addFactory({
    key: 'NB',
    name: 'Notebooks',
    repo: 'acme/notes',
    cloneUrl: path.join(directory, 'notes.git'),
    defaultBranch: 'main',
  }).id
  presence = createPresence()
  sent = []
  answerWith = () => ({ kind: 'sent' })
})

afterEach(async () => {
  vi.useRealTimers()
  notifier?.close()
  notifier = undefined
  presence.close()
  await store.close()
  await rm(directory, { recursive: true, force: true })
})

function startClock(at: string): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(at))
  presence.close()
  presence = createPresence()
}

function pairPhone(name: string, pushToken?: string): string {
  const phone = store.phones.pair({
    name,
    publicKey: `${name}-key`,
    relayKey: `${name}-relay-key`,
    edition: 'dev',
    pairedAt: new Date().toISOString(),
  })
  if (pushToken !== undefined) store.phones.setPushToken(phone.id, pushToken)
  return phone.id
}

function problemSource(): PhoneProblemSource {
  return {
    banners: () => store.listBanners(),
    factoryName: (id) => store.getFactory(id)?.name,
    subscribe: (listener) => store.subscribe(listener),
  }
}

function startNotifier(): PhoneNotifier {
  notifier = createPhoneNotifier({
    store,
    presence,
    push,
    problems: problemSource(),
    log: () => undefined,
  })
  return notifier
}

function raise(problem: string, text: string, severity: Banner['severity'] = 'stops-work'): Banner {
  return store.raiseBanner({ id: `${problem}:${factoryId}`, problem, severity, factoryId, text })
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await notifier?.idle()
}

async function ask(title: string, body: string): Promise<string> {
  const task = await store.createTask({ title, factoryId })
  return store.postComment({ taskId: task.id, author: { kind: 'ted' }, kind: 'question', body }).id
}

test('a request from the 2 idle minutes before the user goes away is sent once when they go away', async () => {
  pairPhone('iPhone', token)
  presence.report(false)
  startNotifier()
  const id = await ask('Pick a parser', 'Which parser should the import use?')
  await settled()
  expect(sent).toEqual([])

  presence.report(true)
  await settled()
  expect(sent).toEqual([
    {
      to: token,
      title: 'Pick a parser',
      body: 'Which parser should the import use?',
      requestId: id,
    },
  ])

  presence.report(false)
  presence.report(true)
  await settled()
  expect(sent).toHaveLength(1)
})

test('a request that started waiting while the user was at the Mac is never sent', async () => {
  startClock('2026-11-19T10:00:00Z')
  pairPhone('iPhone', token)
  presence.report(false)
  startNotifier()
  await ask('Seen at the Mac', 'Rebase now?')
  vi.setSystemTime(new Date('2026-11-19T10:02:01Z'))
  presence.report(false)
  await settled()

  presence.report(true)
  await settled()
  expect(sent).toEqual([])

  const id = await ask('While away', 'Merge now?')
  await settled()
  expect(sent.map((message) => message.requestId)).toEqual([id])
})

test('when the Mac stops reporting, requests from before its last report are never sent', async () => {
  startClock('2026-11-19T10:00:00Z')
  pairPhone('iPhone', token)
  presence.report(false)
  startNotifier()
  await ask('Before', 'Seen?')
  vi.setSystemTime(new Date('2026-11-19T10:00:01Z'))
  presence.report(false)
  vi.setSystemTime(new Date('2026-11-19T10:05:00Z'))
  const id = await ask('After', 'Unseen?')
  await settled()
  expect(sent.map((message) => message.requestId)).toEqual([id])
})

test('a phone is never sent requests that were waiting before it was paired, even after pairing again', async () => {
  startClock('2026-11-19T10:00:00Z')
  presence.report(true)
  startNotifier()
  await ask('Old', 'Waiting since before pairing?')
  vi.setSystemTime(new Date('2026-11-19T10:01:00Z'))
  const first = pairPhone('iPhone', token)
  await settled()
  expect(sent).toEqual([])

  const id = await ask('New', 'After pairing?')
  await settled()
  expect(sent.map((message) => message.requestId)).toEqual([id])

  vi.setSystemTime(new Date('2026-11-19T10:02:00Z'))
  store.phones.remove(first, new Date().toISOString())
  pairPhone('iPhone again', token)
  await settled()
  expect(sent.map((message) => message.requestId)).toEqual([id])
})

test('a first away report sends a request from the 2 minutes before it, with no other event', async () => {
  startClock('2026-11-19T10:00:00Z')
  pairPhone('iPhone', token)
  const id = await ask('Before the daemon started', 'Still waiting?')
  vi.setSystemTime(new Date('2026-11-19T10:00:30Z'))
  presence.close()
  presence = createPresence()
  startNotifier()
  await settled()
  expect(sent).toEqual([])

  presence.report(true)
  await settled()
  expect(sent.map((message) => message.requestId)).toEqual([id])
})

test('a request posted while away is sent at once to every phone with a token', async () => {
  pairPhone('iPhone', token)
  pairPhone('iPad', otherToken)
  pairPhone('Old phone')
  presence.report(true)
  startNotifier()
  const id = await ask('Rename the menu', 'Call it Library or Shelf?')
  await settled()
  expect(sent.map((message) => [message.to, message.requestId])).toEqual([
    [token, id],
    [otherToken, id],
  ])
})

test('the daemon treats no report as away', async () => {
  pairPhone('iPhone', token)
  startNotifier()
  await ask('Pick a color', 'Blue or green?')
  await settled()
  expect(sent).toHaveLength(1)
})

test('a request answered or snoozed before the user goes away is never sent', async () => {
  pairPhone('iPhone', token)
  presence.report(false)
  startNotifier()
  const answered = await ask('Answered', 'Ship it?')
  const snoozed = await ask('Snoozed', 'Later?')
  store.answerComment(answered, { kind: 'answered', at: new Date().toISOString(), text: 'Yes' })
  store.snoozeRequest(snoozed, new Date(Date.now() + 3_600_000).toISOString())
  await settled()

  presence.report(true)
  await settled()
  expect(sent).toEqual([])
})

test('a request answered, or a user back at the Mac, after the request was picked but before its send is not sent', async () => {
  pairPhone('iPhone', token)
  presence.report(false)
  startNotifier()
  const answered = await ask('Answered', 'Ship it?')
  await settled()

  presence.report(true)
  store.answerComment(answered, { kind: 'answered', at: new Date().toISOString(), text: 'Yes' })
  await settled()
  expect(sent).toEqual([])

  presence.report(false)
  const back = await ask('Back at the Mac', 'Rename it?')
  await settled()
  presence.report(true)
  presence.report(false)
  await settled()
  expect(sent).toEqual([])

  presence.report(true)
  await settled()
  expect(sent.map((message) => message.requestId)).toEqual([back])
})

test('a send in progress isn’t started again, and is recorded once it finishes', async () => {
  pairPhone('iPhone', token)
  presence.report(false)
  startNotifier()
  const id = await ask('Slow send', 'Wait for Expo?')
  let finish: (result: PushResult) => void = () => undefined
  const gated: PushService = {
    send(message) {
      sent.push(message)
      return new Promise((resolve) => {
        finish = resolve
      })
    },
  }
  notifier?.close()
  notifier = createPhoneNotifier({ store, presence, push: gated, log: () => undefined })

  presence.report(true)
  await new Promise((resolve) => setImmediate(resolve))
  presence.report(false)
  presence.report(true)
  await new Promise((resolve) => setImmediate(resolve))
  expect(sent.map((message) => message.requestId)).toEqual([id])
  const waiting = store.waiting().find((request) => request.id === id)
  expect(waiting).toBeDefined()
  const since = store.phones.waitingSince(waiting ?? { id, createdAt: '' })
  const phoneId = store.phones.list()[0]?.id ?? ''
  expect(store.phones.notified(phoneId, id, since)).toBe(false)

  finish({ kind: 'sent' })
  await settled()
  expect(store.phones.notified(phoneId, id, since)).toBe(true)
  presence.report(false)
  presence.report(true)
  await settled()
  expect(sent).toHaveLength(1)
})

test('a request back from snooze while its first send is still in progress isn’t sent again', async () => {
  startClock('2026-11-19T10:00:00Z')
  pairPhone('iPhone', token)
  presence.report(true)
  let finish: (result: PushResult) => void = () => undefined
  const gated: PushService = {
    send(message) {
      sent.push(message)
      return new Promise((resolve) => {
        finish = resolve
      })
    },
  }
  notifier = createPhoneNotifier({ store, presence, push: gated, log: () => undefined })
  const id = await ask('Slow send', 'Wait for Expo?')
  await new Promise((resolve) => setImmediate(resolve))
  expect(sent.map((message) => message.requestId)).toEqual([id])

  store.snoozeRequest(id, '2026-11-19T11:00:00.000Z')
  vi.setSystemTime(new Date('2026-11-19T11:00:01Z'))
  expect(store.returnDueRequests(Date.now())).toEqual([id])
  await new Promise((resolve) => setImmediate(resolve))
  expect(sent).toHaveLength(1)

  finish({ kind: 'sent' })
  await settled()
  expect(sent).toHaveLength(1)
})

test('nothing is sent with Inbox notifications off, globally or for the request’s Factory', async () => {
  pairPhone('iPhone', token)
  presence.report(true)
  store.updateSettings({ notifyInboxItems: false })
  startNotifier()
  await ask('Global off', 'Anything?')
  await settled()
  expect(sent).toEqual([])

  store.updateSettings({
    notifyInboxItems: true,
    factoryNotifications: { [factoryId]: { inboxItems: false, taskMerged: false } },
  })
  await settled()
  expect(sent).toEqual([])

  store.updateSettings({
    factoryNotifications: { [factoryId]: { inboxItems: true, taskMerged: false } },
  })
  await settled()
  expect(sent.map((message) => message.title)).toEqual(['Global off'])
})

test('a new notifier on the same store doesn’t send a request again', async () => {
  pairPhone('iPhone', token)
  presence.report(true)
  startNotifier()
  await ask('Once only', 'Merge now?')
  await settled()
  expect(sent).toHaveLength(1)

  notifier?.close()
  await store.close()
  store = await openStore({ directory })
  startNotifier()
  await settled()
  expect(sent).toHaveLength(1)
})

test('a request back from snooze is not sent again', async () => {
  startClock('2026-11-19T10:00:00Z')
  pairPhone('iPhone', token)
  presence.report(true)
  startNotifier()
  const id = await ask('Snooze me', 'Rebase now?')
  await settled()
  expect(sent.map((message) => message.requestId)).toEqual([id])

  store.snoozeRequest(id, '2026-11-19T11:00:00.000Z')
  await settled()
  vi.setSystemTime(new Date('2026-11-19T11:00:01Z'))
  expect(store.returnDueRequests(Date.now())).toEqual([id])
  await settled()
  expect(sent.map((message) => message.requestId)).toEqual([id])
})

test('DeviceNotRegistered clears that phone’s token and nothing more is sent to it', async () => {
  const phoneId = pairPhone('iPhone', token)
  answerWith = () => ({ kind: 'unregistered' })
  presence.report(true)
  startNotifier()
  await ask('First', 'One?')
  await settled()
  expect(store.phones.pushToken(phoneId)).toBeUndefined()

  await ask('Second', 'Two?')
  await settled()
  expect(sent.map((message) => message.title)).toEqual(['First'])
})

test('a failed send is not retried by the notifier and doesn’t stop later sends', async () => {
  pairPhone('iPhone', token)
  answerWith = (message) =>
    message.title === 'Breaks' ? { kind: 'failed', reason: 'Expo answered 400' } : { kind: 'sent' }
  presence.report(true)
  startNotifier()
  await ask('Breaks', 'One?')
  await settled()
  await ask('Works', 'Two?')
  await settled()
  expect(sent.map((message) => message.title)).toEqual(['Breaks', 'Works'])
})

test('removing a phone clears its token', () => {
  const phoneId = pairPhone('iPhone', token)
  expect(store.phones.pushToken(phoneId)).toBe(token)
  expect(store.phones.remove(phoneId, new Date().toISOString())).toBe(true)
  expect(store.phones.pushToken(phoneId)).toBeUndefined()
  expect(store.phones.setPushToken(phoneId, token)).toBe(false)
})

test('the relay list holds paired phones’ relay keys, and its revision only grows', () => {
  expect(store.phones.relayList()).toEqual({ rev: 0, keys: [] })
  expect(store.phones.pairAgain()).toBe(false)
  expect(store.phones.relayAcked()).toBeUndefined()
  store.phones.markRelayAcked({ rev: 0, hash: 'hash-0' })
  store.phones.markRelayAcked({ rev: 0, hash: 'hash-0' })
  expect(store.phones.relayAcked()).toEqual({ rev: 0, hash: 'hash-0' })
  const pair = (name: string, pairedAt: string) =>
    store.phones.pair({
      name,
      publicKey: `${name}-key`,
      relayKey: `${name}-relay`,
      edition: 'dev',
      pairedAt,
    }).id
  const first = pair('First', '2026-11-19T10:00:00.000Z')
  pair('Second', '2026-11-19T10:01:00.000Z')
  expect(store.phones.byRelayKey('Second-relay')).toMatchObject({ name: 'Second' })
  expect(store.phones.relayList()).toEqual({ rev: 2, keys: ['First-relay', 'Second-relay'] })
  store.phones.setPushToken(first, token)
  store.phones.remove(first, '2026-11-19T10:02:00.000Z')
  expect(store.phones.relayList()).toEqual({ rev: 3, keys: ['Second-relay'] })
  expect(store.phones.byRelayKey('First-relay')).toBeUndefined()

  const kept = pair('Kept', '2026-11-19T10:03:00.000Z')
  store.phones.setPushToken(kept, otherToken)
  store.phones.resetRelay({ at: '2026-11-19T10:04:00.000Z', channel: 'old-channel' })
  expect(store.phones.latestReset()).toEqual({
    at: '2026-11-19T10:04:00.000Z',
    channel: 'old-channel',
  })
  expect(store.phones.list()).toEqual([])
  expect(store.phones.pushToken(kept)).toBeUndefined()
  expect(store.phones.relayList()).toEqual({ rev: 7, keys: [] })
  expect(store.phones.pairAgain()).toBe(true)

  pair('Again', '2026-11-19T10:05:00.000Z')
  expect(store.phones.pairAgain()).toBe(false)
  expect(store.phones.relayList()).toEqual({ rev: 8, keys: ['Again-relay'] })
})

test('a token moves to the phone that registered it last', () => {
  const first = pairPhone('Old pairing', token)
  const second = pairPhone('New pairing', token)
  expect(store.phones.pushToken(first)).toBeUndefined()
  expect(store.phones.pushToken(second)).toBe(token)
})

test('a notification is recorded once per phone, request and waiting time', () => {
  const phoneId = pairPhone('iPhone', token)
  const mark = { phoneId, requestId: 'r1', waitingSince: '2026-11-19T10:00:00.000Z', at: 'now' }
  expect(store.phones.notified(phoneId, 'r1', mark.waitingSince)).toBe(false)
  expect(store.phones.markNotified(mark)).toBe(true)
  expect(store.phones.markNotified(mark)).toBe(false)
  expect(store.phones.notified(phoneId, 'r1', mark.waitingSince)).toBe(true)
  expect(store.phones.notified(phoneId, 'r1', '2026-11-19T11:00:00.000Z')).toBe(false)
  expect(store.phones.everNotified(phoneId, 'r1')).toBe(true)
  expect(store.phones.everNotified(phoneId, 'r2')).toBe(false)
})

const base = { factoryId: 'f', createdAt: '2026-11-19T10:00:00.000Z' }

test('notification text is redacted, shortened, and a permission request never shows its command', () => {
  const question: WaitingRequest = {
    ...base,
    id: 'q',
    source: 'task',
    kind: 'question',
    failed: false,
    taskId: 't',
    displayId: 'NB-1',
    taskTitle: 'Use ghp_abcdefghijklmnopqrstuvwxyz0123456789 for the mirror',
    headline: `Push to https://user:hunter2@example.com? ${'x'.repeat(400)}`,
  }
  const text = pushText(question)
  expect(text.title).toBe('Use [redacted] for the mirror')
  expect(text.body).toContain('https://[redacted]@example.com')
  expect(text.body).not.toContain('hunter2')
  expect([...text.body]).toHaveLength(pushTextMax)

  const permission: WaitingRequest = {
    ...question,
    id: 'p',
    kind: 'permission',
    headline: 'Run rm -rf build && npm publish',
  }
  expect(pushText(permission).body).toBe(permissionBody)

  const outside: WaitingRequest = {
    ...base,
    id: 'c',
    source: 'coordinator',
    chatId: 'chat',
    chatTitle: 'Release chat',
    agentName: 'Coordinator',
    requestKind: 'outside-command',
    headline: 'Run git push --force',
  }
  expect(pushText(outside)).toEqual({ title: 'Release chat', body: permissionBody })

  const automation: WaitingRequest = {
    ...base,
    id: 'a',
    source: 'automation',
    automationId: 'auto',
    automationName: 'Nightly sweep',
    headline: 'Close stale issues?',
  }
  expect(pushText(automation)).toEqual({ title: 'Nightly sweep', body: 'Close stale issues?' })
})

test('a stops-work problem raised while away sends one notification that opens Problems; clearing it sends nothing', async () => {
  pairPhone('iPhone', token)
  presence.report(true)
  startNotifier()
  const banner = raise('clone-failed', 'Couldn’t clone acme/notes · Notebooks can’t start Tasks')
  await settled()
  expect(sent).toEqual([
    {
      to: token,
      title: 'Work stopped · Notebooks',
      body: 'Couldn’t clone acme/notes · Notebooks can’t start Tasks',
      opens: 'problems',
    },
  ])

  store.clearBanner(banner.id)
  await settled()
  expect(sent).toHaveLength(1)

  await new Promise((resolve) => setTimeout(resolve, 5))
  raise('clone-failed', 'Couldn’t clone acme/notes · Notebooks can’t start Tasks')
  await settled()
  expect(sent).toHaveLength(2)
  expect(sent.every((message) => message.opens === 'problems')).toBe(true)
})

test('a problem raised at the Mac is sent when the user becomes away, and not if it cleared first', async () => {
  pairPhone('iPhone', token)
  presence.report(false)
  startNotifier()
  raise('disk-full', 'Disk full · new work held')
  const cleared = raise('provider-signed-out', 'Claude is signed out')
  await settled()
  expect(sent).toEqual([])

  store.clearBanner(cleared.id)
  presence.report(true)
  await settled()
  expect(sent.map((message) => message.body)).toEqual(['Disk full · new work held'])

  presence.report(false)
  presence.report(true)
  await settled()
  expect(sent).toHaveLength(1)
})

test('a problem raised while the user was at the Mac, or before the phone was paired, is never sent', async () => {
  startClock('2026-11-19T10:00:00Z')
  presence.report(true)
  startNotifier()
  raise('disk-full', 'Disk full · new work held')
  vi.setSystemTime(new Date('2026-11-19T10:01:00Z'))
  pairPhone('iPhone', token)
  await settled()
  expect(sent).toEqual([])

  presence.report(false)
  raise('provider-signed-out', 'Claude is signed out')
  vi.setSystemTime(new Date('2026-11-19T10:03:01Z'))
  presence.report(false)
  presence.report(true)
  await settled()
  expect(sent).toEqual([])
})

test('warnings never notify, and the Problems setting turns problem notifications off', async () => {
  pairPhone('iPhone', token)
  presence.report(true)
  store.updateSettings({ notifyProblems: false })
  startNotifier()
  raise('disk-low', 'Disk almost full', 'warning')
  raise('disk-full', 'Disk full · new work held')
  await settled()
  expect(sent).toEqual([])

  store.updateSettings({ notifyProblems: true })
  await settled()
  expect(sent.map((message) => message.body)).toEqual(['Disk full · new work held'])
})

test('a problem notification is not repeated after a restart', async () => {
  pairPhone('iPhone', token)
  presence.report(true)
  startNotifier()
  raise('disk-full', 'Disk full · new work held')
  await settled()
  notifier?.close()
  startNotifier()
  raise('disk-full', 'Disk full · new work held · 1 GB free')
  await settled()
  expect(sent).toHaveLength(1)
})

test('problem notification text names the Factory or Ted, redacted and shortened', () => {
  const banner: Banner = {
    id: 'disk-full:app',
    problem: 'disk-full',
    severity: 'stops-work',
    text: `Can’t reach https://user:hunter2@example.com ${'x'.repeat(400)}`,
    raisedAt: '2026-11-19T10:00:00.000Z',
  }
  const text = problemPushText(banner, undefined)
  expect(text.title).toBe('Work stopped · Ted')
  expect(text.body).not.toContain('hunter2')
  expect([...text.body]).toHaveLength(pushTextMax)
  expect(problemPushText({ ...banner, factoryId: 'f' }, 'Notebooks').title).toBe(
    'Work stopped · Notebooks',
  )
})
