import {
  fromBase64Url,
  type MacReplyMessage,
  minPhoneProtocolVersion,
  type PhoneErrorCode,
  type PhoneMessageHeader,
  type PhoneReplyBody,
  type PhoneRequest,
  parsePhoneMessageHeader,
  parsePhoneRequest,
  phoneProtocolVersion,
} from '@ted/protocol'
import type { Json } from '@ted/protocol/parse'
import type { PhoneStore } from '../store/index.ts'
import { createReplayGuard, seal, unseal } from './crypto.ts'
import type { PhoneKeys } from './keys.ts'
import type { Pairings } from './pairings.ts'
import { type PhoneRouteContext, phoneRoutes } from './routes.ts'

export const phoneErrorMessages: Readonly<Record<PhoneErrorCode, string>> = {
  'not-paired': 'This phone isn’t paired with this Mac.',
  expired: 'This pairing code has expired. Make a new one on your Mac.',
  used: 'This pairing code has already been used. Make a new one on your Mac.',
  'wrong-edition':
    'This phone app and Ted on your Mac don’t match. Pair Ted with the Ted app, and Ted Dev with the Ted Dev app.',
  'too-old': 'Update the Ted app on your phone.',
  'too-new': 'Update Ted on your Mac.',
  'bad-request': 'Ted on your Mac couldn’t read this request.',
  'unknown-route': 'Ted on your Mac doesn’t know this request.',
  gone: 'This request was answered or closed on your Mac.',
  'answer-on-mac': 'Answer this request on your Mac.',
  refused: 'Ted on your Mac couldn’t take this answer.',
}

export interface PhoneBridgeOptions {
  keys: PhoneKeys
  phones: PhoneStore
  pairings: Pairings
  routes: PhoneRouteContext
  now: () => number
  send(conn: number, data: string): void
  reached(phoneId: string): void
  candidate(pairing: string, relayKey: string): void
  pairingAnswered(pairing: string): void
}

export interface PhoneBridge {
  handle(conn: number, data: string): Promise<void>
}

function versionProblem(protocol: number): PhoneErrorCode | undefined {
  if (protocol < minPhoneProtocolVersion) return 'too-old'
  if (protocol > phoneProtocolVersion) return 'too-new'
  return undefined
}

function request(message: Json): PhoneRequest | undefined {
  try {
    return parsePhoneRequest(message)
  } catch {
    return undefined
  }
}

export function createPhoneBridge(options: PhoneBridgeOptions): PhoneBridge {
  const { keys, phones, pairings, now } = options
  const replay = createReplayGuard(now)

  return {
    async handle(conn, data) {
      const opened = unseal(data, keys.box)
      if (!opened) return
      let header: PhoneMessageHeader
      try {
        header = parsePhoneMessageHeader(opened.message)
      } catch {
        return
      }
      if (!replay.accept(opened.from, opened.nonce, header.at)) return
      const senderKey = fromBase64Url(opened.from, 32)
      if (!senderKey) return
      const reply = (
        outcome: { body: PhoneReplyBody } | { code: PhoneErrorCode; message?: string },
      ) => {
        const common = {
          protocol: phoneProtocolVersion,
          id: header.id,
          at: now(),
          type: 'reply' as const,
        }
        const message: MacReplyMessage =
          'body' in outcome
            ? { ...common, ok: true, body: outcome.body }
            : {
                ...common,
                ok: false,
                error: {
                  code: outcome.code,
                  message: outcome.message ?? phoneErrorMessages[outcome.code],
                },
              }
        options.send(conn, seal(message, senderKey, keys.box))
      }

      if (pairings.candidate(opened.from) && header.type !== 'pair-status') return

      if (header.type === 'pair') {
        const pair = request(opened.message)
        if (pair?.type !== 'pair') return reply({ code: 'bad-request' })
        const result = pairings.take(
          pair,
          opened.from,
          keys.box.publicKey,
          (relayKey) => phones.byRelayKey(relayKey) !== undefined,
        )
        if (!result.ok) return reply({ code: result.code })
        options.candidate(pair.pairing, result.relayKey)
        return reply({ body: { state: 'waiting', code: result.code } })
      }

      const paired = phones.byKey(opened.from)
      if (header.type === 'pair-status') {
        const problem = versionProblem(header.protocol)
        if (problem) return reply({ code: problem })
        const status = request(opened.message)
        if (status?.type !== 'pair-status') return reply({ code: 'bad-request' })
        const known = pairings.status(status.pairing, opened.from)?.state
        const state =
          known === undefined || known === 'approved' ? (paired ? 'approved' : 'expired') : known
        if (state === 'waiting') return reply({ body: { state } })
        reply({
          body: state === 'approved' ? { state, mac: await options.routes.macName() } : { state },
        })
        options.pairingAnswered(status.pairing)
        return
      }

      if (!paired) return reply({ code: 'not-paired' })
      const problem = versionProblem(header.protocol)
      if (problem) return reply({ code: problem })
      const asked = request(opened.message)
      if (asked?.type !== 'request') return reply({ code: 'bad-request' })
      const route = phoneRoutes.find((entry) => entry.name === asked.route)
      if (!route) return reply({ code: 'unknown-route' })
      options.reached(paired.id)
      return reply(await route.handle({ kind: 'phone', phoneId: paired.id }, asked, options.routes))
    },
  }
}
