import {
  fromBase64Url,
  type MacReplyMessage,
  type PhoneEnvelope,
  type PhoneRequest,
  parsePhoneEnvelope,
  phoneEnvelopeVersion,
  phoneMessageWindowMs,
  toBase64Url,
} from '@ted/protocol'
import { type Json, parseJson } from '@ted/protocol/parse'
import nacl from 'tweetnacl'

export interface BoxKeys {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

export interface OpenedEnvelope {
  from: string
  nonce: string
  message: Json
}

export function seal(
  message: MacReplyMessage | PhoneRequest,
  recipient: Uint8Array,
  sender: BoxKeys,
): string {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const box = nacl.box(
    new TextEncoder().encode(JSON.stringify(message)),
    nonce,
    recipient,
    sender.secretKey,
  )
  const envelope: PhoneEnvelope = {
    v: phoneEnvelopeVersion,
    from: toBase64Url(sender.publicKey),
    nonce: toBase64Url(nonce),
    box: toBase64Url(box),
  }
  return JSON.stringify(envelope)
}

export function unseal(data: string, recipient: BoxKeys): OpenedEnvelope | undefined {
  let envelope: PhoneEnvelope
  try {
    envelope = parsePhoneEnvelope(parseJson(data))
  } catch {
    return undefined
  }
  if (envelope.v !== phoneEnvelopeVersion) return undefined
  const from = fromBase64Url(envelope.from, nacl.box.publicKeyLength)
  const nonce = fromBase64Url(envelope.nonce, nacl.box.nonceLength)
  const box = fromBase64Url(envelope.box)
  if (!from || !nonce || !box) return undefined
  const opened = nacl.box.open(box, nonce, from, recipient.secretKey)
  if (!opened) return undefined
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(opened)
  } catch {
    return undefined
  }
  const message = parseJson(text)
  if (message === undefined) return undefined
  return { from: envelope.from, nonce: envelope.nonce, message }
}

export interface ReplayGuard {
  accept(from: string, nonce: string, at: number): boolean
}

export function createReplayGuard(now: () => number, windowMs = phoneMessageWindowMs): ReplayGuard {
  const seen = new Map<string, number>()
  return {
    accept(from, nonce, at) {
      const time = now()
      for (const [key, when] of seen) if (time - when > windowMs) seen.delete(key)
      if (Math.abs(time - at) > windowMs) return false
      const key = `${from}.${nonce}`
      if (seen.has(key)) return false
      seen.set(key, time)
      return true
    },
  }
}
