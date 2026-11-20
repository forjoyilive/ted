import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  type Edition,
  encodePairingLink,
  fromBase64Url,
  minPhoneProtocolVersion,
  type PairStatusBody,
  type PhoneErrorCode,
  type PhonePairingOffer,
  type PhonePairingState,
  pairingLifetimeMs,
  pairingLinkVersion,
  phoneProtocolVersion,
  shortCode,
  toBase64Url,
} from '@ted/protocol'
import { RequestError } from '../errors.ts'
import type { PhoneKeys } from './keys.ts'

interface WaitingPhone {
  key: string
  name: string
  edition: Edition
}

interface LivePairing {
  id: string
  secret: Uint8Array
  expiresAt: number
  link: string
  state: 'live' | 'waiting' | 'approved' | 'refused' | 'spent'
  phone?: WaitingPhone
  code?: string
}

export interface PairAttempt {
  pairing: string
  secret: string
  name: string
  edition: Edition
  protocol: number
}

export type PairResult = { ok: true; code: string } | { ok: false; code: PhoneErrorCode }

export interface Pairings {
  create(keys: PhoneKeys, relay: string): PhonePairingOffer
  cancel(): void
  current(): PhonePairingState
  live(): boolean
  expiresAt(): number | undefined
  take(attempt: PairAttempt, phoneKey: string, macKey: Uint8Array): PairResult
  status(pairing: string, phoneKey: string): PairStatusBody
  approve(pairing: string): WaitingPhone
  refuse(pairing: string): void
}

export function createPairings(now: () => number, ourEdition: Edition): Pairings {
  let current: LivePairing | undefined
  const expired = (pairing: LivePairing) =>
    (pairing.state === 'live' || pairing.state === 'waiting') && now() >= pairing.expiresAt
  const matching = (id: string) => {
    const pairing = current
    if (!pairing || pairing.id.length !== id.length) return undefined
    return timingSafeEqual(Buffer.from(pairing.id), Buffer.from(id)) ? pairing : undefined
  }
  const decidable = (id: string): LivePairing & { phone: WaitingPhone } => {
    const pairing = matching(id)
    if (!pairing || expired(pairing) || pairing.state !== 'waiting' || !pairing.phone) {
      throw new RequestError(409, 'This pairing is no longer waiting for approval.')
    }
    return { ...pairing, phone: pairing.phone }
  }
  return {
    create(keys, relay) {
      const id = toBase64Url(randomBytes(16))
      const secret = new Uint8Array(randomBytes(32))
      const expiresAt = now() + pairingLifetimeMs
      const link = encodePairingLink({
        v: pairingLinkVersion,
        edition: ourEdition,
        relay,
        channel: keys.channel,
        macKey: toBase64Url(keys.box.publicKey),
        pairing: id,
        secret: toBase64Url(secret),
        expiresAt,
      })
      current = { id, secret, expiresAt, link, state: 'live' }
      return { pairing: id, link, expiresAt }
    },
    cancel() {
      current = undefined
    },
    current() {
      const pairing = current
      if (!pairing) return { state: 'none' }
      if (expired(pairing) || pairing.state === 'spent') {
        return { state: 'expired', pairing: pairing.id }
      }
      if (pairing.state === 'live') {
        return {
          state: 'live',
          pairing: pairing.id,
          link: pairing.link,
          expiresAt: pairing.expiresAt,
        }
      }
      const phoneName = pairing.phone?.name ?? ''
      if (pairing.state === 'waiting') {
        return {
          state: 'waiting',
          pairing: pairing.id,
          link: pairing.link,
          expiresAt: pairing.expiresAt,
          phoneName,
          code: pairing.code ?? '',
        }
      }
      return { state: pairing.state, pairing: pairing.id, phoneName }
    },
    live() {
      const pairing = current
      return (
        pairing !== undefined &&
        !expired(pairing) &&
        (pairing.state === 'live' || pairing.state === 'waiting')
      )
    },
    expiresAt() {
      return current?.expiresAt
    },
    take(attempt, phoneKey, macKey) {
      const pairing = matching(attempt.pairing)
      const secret = fromBase64Url(attempt.secret, 32)
      if (!pairing || !secret || expired(pairing)) return { ok: false, code: 'expired' }
      if (!timingSafeEqual(Buffer.from(secret), Buffer.from(pairing.secret))) {
        return { ok: false, code: 'expired' }
      }
      if (pairing.state !== 'live') return { ok: false, code: 'used' }
      pairing.state = 'spent'
      if (attempt.edition !== ourEdition) return { ok: false, code: 'wrong-edition' }
      if (attempt.protocol < minPhoneProtocolVersion) return { ok: false, code: 'too-old' }
      if (attempt.protocol > phoneProtocolVersion) return { ok: false, code: 'too-new' }
      const key = fromBase64Url(phoneKey, 32)
      if (!key) return { ok: false, code: 'bad-request' }
      pairing.state = 'waiting'
      pairing.phone = { key: phoneKey, name: attempt.name, edition: attempt.edition }
      pairing.code = shortCode(macKey, key, secret)
      return { ok: true, code: pairing.code }
    },
    status(id, phoneKey) {
      const pairing = matching(id)
      if (!pairing || pairing.phone?.key !== phoneKey || expired(pairing)) {
        return { state: 'expired' }
      }
      if (pairing.state === 'waiting') return { state: 'waiting' }
      if (pairing.state === 'refused') return { state: 'refused' }
      if (pairing.state === 'approved') return { state: 'approved', mac: '' }
      return { state: 'expired' }
    },
    approve(id) {
      const pairing = decidable(id)
      if (current) current.state = 'approved'
      return pairing.phone
    },
    refuse(id) {
      decidable(id)
      if (current) current.state = 'refused'
    },
  }
}
