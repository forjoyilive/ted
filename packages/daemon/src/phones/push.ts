import { isArray, isObject, isString, type Json, parseJson } from '@ted/protocol/parse'
import { redactSecrets } from '../redact.ts'

export const expoPushUrl = 'https://exp.host/--/api/v2/push/send'
export const pushAttempts = 3
export const pushTimeoutMs = 10_000
export const pushBackoffMs = 1_000

export interface PushMessage {
  to: string
  title: string
  body: string
  requestId: string
}

export type PushResult =
  | { kind: 'sent' }
  | { kind: 'unregistered' }
  | { kind: 'failed'; reason: string }

export interface PushService {
  send(message: PushMessage): Promise<PushResult>
}

export const noPush: PushService = {
  send: async () => ({ kind: 'failed', reason: 'push notifications are off' }),
}

export interface PushResponse {
  status: number
  text(): Promise<string>
}

export interface PushRequestInit {
  method: 'POST'
  headers: { accept: string; 'accept-encoding': string; 'content-type': string }
  body: string
  signal: AbortSignal
}

export type PushFetch = (url: string, init: PushRequestInit) => Promise<PushResponse>

export interface ExpoPushOptions {
  fetch?: PushFetch
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
  timeoutMs?: number
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref()
  })

export function maskPushToken(text: string, token: string): string {
  const open = token.indexOf('[')
  const shown = open === -1 ? '' : token.slice(0, open + 1 + 4)
  return text.replaceAll(token, `${shown}…]`)
}

type Ticket = { kind: 'ok' } | { kind: 'error'; code?: string; message: string }

function ticketOf(value: Json | undefined): Ticket | undefined {
  if (!isObject(value)) return undefined
  const data = isArray(value.data) ? value.data[0] : value.data
  if (!isObject(data)) return undefined
  if (data.status === 'ok') return { kind: 'ok' }
  if (data.status !== 'error') return undefined
  const details = isObject(data.details) ? data.details : undefined
  return {
    kind: 'error',
    ...(isString(details?.error) && { code: details.error }),
    message: isString(data.message) ? data.message : 'Expo refused the notification',
  }
}

function requestErrors(value: Json | undefined): string | undefined {
  if (!isObject(value) || !isArray(value.errors)) return undefined
  const messages = value.errors.flatMap((error) =>
    isObject(error) && isString(error.message) ? [error.message] : [],
  )
  return messages.length > 0 ? messages.join('; ') : undefined
}

function retryable(status: number): boolean {
  return status === 429 || status >= 500
}

export function createExpoPush(options: ExpoPushOptions = {}): PushService {
  const doFetch: PushFetch = options.fetch ?? fetch
  const sleep = options.sleep ?? realSleep
  const log = options.log ?? ((line: string) => console.error(line))
  const timeoutMs = options.timeoutMs ?? pushTimeoutMs

  return {
    async send(message) {
      const clean = (text: string) => redactSecrets(maskPushToken(text, message.to))
      const fail = (reason: string): PushResult => {
        const cleaned = clean(reason)
        log(`a phone notification wasn’t sent: ${cleaned}`)
        return { kind: 'failed', reason: cleaned }
      }
      const body = JSON.stringify([
        {
          to: message.to,
          title: message.title,
          body: message.body,
          data: { requestId: message.requestId },
          sound: 'default',
        },
      ])
      let lastProblem = 'no attempt was made'
      for (let attempt = 0; attempt < pushAttempts; attempt += 1) {
        if (attempt > 0) await sleep(pushBackoffMs * 2 ** (attempt - 1))
        let status: number
        let text: string
        try {
          const response = await doFetch(expoPushUrl, {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'accept-encoding': 'gzip, deflate',
              'content-type': 'application/json',
            },
            body,
            signal: AbortSignal.timeout(timeoutMs),
          })
          status = response.status
          text = await response.text()
        } catch (error) {
          lastProblem = `network error: ${error instanceof Error ? error.message : String(error)}`
          continue
        }
        const json = parseJson(text)
        if (retryable(status)) {
          lastProblem = `Expo answered ${status}${requestErrors(json) ? `: ${requestErrors(json)}` : ''}`
          continue
        }
        if (status < 200 || status >= 300) {
          return fail(`Expo answered ${status}: ${requestErrors(json) ?? 'no reason given'}`)
        }
        const ticket = ticketOf(json)
        if (!ticket) return fail('Expo’s answer had no ticket')
        if (ticket.kind === 'ok') return { kind: 'sent' }
        if (ticket.code === 'DeviceNotRegistered') {
          log(`a phone is no longer registered for notifications: ${clean(ticket.message)}`)
          return { kind: 'unregistered' }
        }
        return fail(`${ticket.code ?? 'error'}: ${ticket.message}`)
      }
      return fail(`gave up after ${pushAttempts} attempts, last: ${lastProblem}`)
    },
  }
}
