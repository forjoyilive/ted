import type { Json } from '@ted/protocol/parse'
import { expect, test } from 'vitest'
import {
  createExpoPush,
  expoPushUrl,
  type PushFetch,
  type PushRequestInit,
  pushAttempts,
} from '../src/phones/push.ts'

const token = 'ExponentPushToken[abcdefghijklmnop]'
const message = { to: token, title: 'Pick a parser', body: 'Which one?', requestId: 'req-1' }

type Answer = { status: number; body: Json } | Error

function stubFetch(answers: Answer[]) {
  const calls: { url: string; init: PushRequestInit }[] = []
  const fetch: PushFetch = async (url, init) => {
    calls.push({ url, init })
    const answer = answers.shift() ?? new Error('no more answers')
    if (answer instanceof Error) throw answer
    return { status: answer.status, text: async () => JSON.stringify(answer.body) }
  }
  return { fetch, calls }
}

function client(answers: Answer[]) {
  const stub = stubFetch(answers)
  const slept: number[] = []
  const logged: string[] = []
  const push = createExpoPush({
    fetch: stub.fetch,
    sleep: async (ms) => {
      slept.push(ms)
    },
    log: (line) => logged.push(line),
  })
  return { push, calls: stub.calls, slept, logged }
}

const ok = { status: 200, body: { data: [{ status: 'ok', id: 'ticket-1' }] } }

test('sends one message to Expo with the request ID as its only data', async () => {
  const { push, calls, slept } = client([ok])
  expect(await push.send(message)).toEqual({ kind: 'sent' })
  expect(slept).toEqual([])
  expect(calls).toHaveLength(1)
  expect(calls[0]?.url).toBe(expoPushUrl)
  expect(calls[0]?.init.method).toBe('POST')
  expect(JSON.parse(calls[0]?.init.body ?? '')).toEqual([
    {
      to: token,
      title: 'Pick a parser',
      body: 'Which one?',
      data: { requestId: 'req-1' },
      sound: 'default',
    },
  ])
})

test('retries network errors, 429 and 5xx with growing waits, at most three attempts', async () => {
  const recovered = client([new Error('socket hang up'), { status: 503, body: {} }, ok])
  expect(await recovered.push.send(message)).toEqual({ kind: 'sent' })
  expect(recovered.calls).toHaveLength(3)
  expect(recovered.slept).toHaveLength(2)
  expect(recovered.slept[1]).toBeGreaterThan(recovered.slept[0] ?? 0)

  const limited = client([
    { status: 429, body: {} },
    { status: 429, body: {} },
    { status: 429, body: {} },
    ok,
  ])
  expect(await limited.push.send(message)).toMatchObject({ kind: 'failed' })
  expect(limited.calls).toHaveLength(pushAttempts)
  expect(limited.logged).toHaveLength(1)
})

test('doesn’t retry another 4xx', async () => {
  const { push, calls, logged } = client([
    { status: 400, body: { errors: [{ code: 'VALIDATION_ERROR', message: 'bad body' }] } },
    ok,
  ])
  expect(await push.send(message)).toEqual({
    kind: 'failed',
    reason: 'Expo answered 400: bad body',
  })
  expect(calls).toHaveLength(1)
  expect(logged).toHaveLength(1)
})

test('a DeviceNotRegistered ticket tells the caller to clear the token, which is never logged whole', async () => {
  const { push, logged } = client([
    {
      status: 200,
      body: {
        data: [
          {
            status: 'error',
            message: `"${token}" is not a registered push notification recipient`,
            details: { error: 'DeviceNotRegistered' },
          },
        ],
      },
    },
  ])
  expect(await push.send(message)).toEqual({ kind: 'unregistered' })
  expect(logged.join('\n')).not.toContain(token)
  expect(logged.join('\n')).toContain('ExponentPushToken[abcd…]')
})

test('another error ticket fails without retrying and logs through redaction', async () => {
  const { push, calls, logged } = client([
    {
      status: 200,
      body: {
        data: [
          {
            status: 'error',
            message: `Bad credentials ghp_abcdefghijklmnopqrstuvwxyz0123456789 for ${token}`,
            details: { error: 'InvalidCredentials' },
          },
        ],
      },
    },
  ])
  const result = await push.send(message)
  expect(result).toMatchObject({ kind: 'failed' })
  expect(calls).toHaveLength(1)
  const line = logged.join('\n')
  expect(line).toContain('InvalidCredentials')
  expect(line).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
  expect(line).not.toContain(token)
})

test('an answer without a ticket fails instead of throwing', async () => {
  const { push } = client([{ status: 200, body: 'not json at all' }])
  expect(await push.send(message)).toMatchObject({ kind: 'failed' })
})
