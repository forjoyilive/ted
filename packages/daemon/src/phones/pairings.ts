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
  relayKeyProofText,
  relayTicket,
  relayTicketHash,
  shortCode,
  toBase64Url,
} from '@ted/protocol'
import nacl from 'tweetnacl'
import { RequestError } from '../errors.ts'
import type { PhoneKeys } from './keys.ts'

interface WaitingPhone {
  key: string
  relayKey: string
  name: string
  edition: Edition
}

interface LivePairing {
  id: string
  secret: Uint8Array
  ticketHash: string
  expiresAt: number
  link: string
  state: 'live' | 'waiting' | 'approved' | 'refused' | 'spent'
  phone?: WaitingPhone
  code?: string
  listRev?: number
  listed: boolean
  ended: boolean
}

export interface PairAttempt {
  pairing: string
  secret: string
  name: string
  edition: Edition
  protocol: number
  relayKey?: string
  relayProof?: string
}

export type PairResult =
  | { ok: true; code: string; relayKey: string }
  | { ok: false; code: PhoneErrorCode }

export interface CreatedPairing {
  offer: PhonePairingOffer
  ticketHash: string
}

export interface PairingTicket {
  pairing: string
  ticketHash: string
  expiresAt: number
  used: boolean
}

export interface Pairings {
  create(keys: PhoneKeys, relay: string): CreatedPairing
  cancel(): void
  current(): PhonePairingState
  ticket(): PairingTicket | undefined
  live(): boolean
  take(
    attempt: PairAttempt,
    phoneKey: string,
    macKey: Uint8Array,
    relayKeyTaken: (relayKey: string) => boolean,
  ): PairResult
  status(pairing: string, phoneKey: string): PairStatusBody | undefined
  candidate(phoneKey: string): boolean
  approve(pairing: string, listRev: number): WaitingPhone
  listed(rev: number): void
  refuse(pairing: string): void
  ended(pairing: string): void
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
      const ticketHash = relayTicketHash(relayTicket(secret, keys.channel, id))
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
      current = {
        id,
        secret,
        ticketHash,
        expiresAt,
        link,
        state: 'live',
        listed: false,
        ended: false,
      }
      return { offer: { pairing: id, link, expiresAt, edition: ourEdition }, ticketHash }
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
          edition: ourEdition,
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
    ticket() {
      const pairing = current
      if (!pairing) return undefined
      return {
        pairing: pairing.id,
        ticketHash: pairing.ticketHash,
        expiresAt: pairing.expiresAt,
        used: pairing.phone !== undefined,
      }
    },
    live() {
      const pairing = current
      return (
        pairing !== undefined &&
        !expired(pairing) &&
        (pairing.state === 'live' || pairing.state === 'waiting')
      )
    },
    take(attempt, phoneKey, macKey, relayKeyTaken) {
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
      const relayKey = attempt.relayKey && fromBase64Url(attempt.relayKey, 32)
      const proof = attempt.relayProof && fromBase64Url(attempt.relayProof, 64)
      if (!key || !relayKey || !proof || !attempt.relayKey)
        return { ok: false, code: 'bad-request' }
      const proven = nacl.sign.detached.verify(
        new TextEncoder().encode(relayKeyProofText(pairing.id, phoneKey)),
        proof,
        relayKey,
      )
      if (!proven || relayKeyTaken(attempt.relayKey)) return { ok: false, code: 'bad-request' }
      pairing.state = 'waiting'
      pairing.phone = {
        key: phoneKey,
        relayKey: attempt.relayKey,
        name: attempt.name,
        edition: attempt.edition,
      }
      pairing.code = shortCode(macKey, key, secret)
      return { ok: true, code: pairing.code, relayKey: attempt.relayKey }
    },
    status(id, phoneKey) {
      const pairing = matching(id)
      if (!pairing || pairing.phone?.key !== phoneKey) return undefined
      if (expired(pairing)) return { state: 'expired' }
      if (pairing.state === 'refused') return { state: 'refused' }
      if (pairing.state === 'approved' && pairing.listed) return { state: 'approved', mac: '' }
      if (pairing.state === 'waiting' || pairing.state === 'approved') return { state: 'waiting' }
      return { state: 'expired' }
    },
    candidate(phoneKey) {
      return current !== undefined && !current.ended && current.phone?.key === phoneKey
    },
    approve(id, listRev) {
      const pairing = decidable(id)
      if (current) {
        current.state = 'approved'
        current.listRev = listRev
      }
      return pairing.phone
    },
    listed(rev) {
      if (current?.listRev !== undefined && current.listRev <= rev) current.listed = true
    },
    refuse(id) {
      decidable(id)
      if (current) current.state = 'refused'
    },
    ended(id) {
      if (current?.id === id) current.ended = true
    },
  }
}
