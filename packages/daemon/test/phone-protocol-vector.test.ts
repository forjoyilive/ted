import { readFileSync } from 'node:fs'
import {
  fromBase64Url,
  type MacReplyMessage,
  type PhoneRequest,
  parsePhoneRequest,
  shortCode,
  toBase64Url,
} from '@ted/protocol'
import nacl from 'tweetnacl'
import { expect, test } from 'vitest'
import { seal, unseal } from '../src/phones/crypto.ts'

interface Vector {
  macSecretKey: string
  macPublicKey: string
  phoneSecretKey: string
  phonePublicKey: string
  pairingSecret: string
  pairing: string
  nonce: string
  message: PhoneRequest
  envelope: string
  shortCode: string
  replyNonce: string
  reply: MacReplyMessage
  replyEnvelope: string
}

const vector = JSON.parse(
  readFileSync(new URL('./fixtures/phone-protocol-vector.json', import.meta.url), 'utf8'),
) as Vector

const bytes = (text: string) => {
  const value = fromBase64Url(text)
  if (!value) throw new Error(`not base64url: ${text}`)
  return value
}

const mac = nacl.box.keyPair.fromSecretKey(bytes(vector.macSecretKey))
const phone = nacl.box.keyPair.fromSecretKey(bytes(vector.phoneSecretKey))

test('the shared vector’s keys and short code match ted-mobile’s', () => {
  expect(toBase64Url(mac.publicKey)).toBe(vector.macPublicKey)
  expect(toBase64Url(phone.publicKey)).toBe(vector.phonePublicKey)
  expect(shortCode(mac.publicKey, phone.publicKey, bytes(vector.pairingSecret))).toBe(
    vector.shortCode,
  )
  expect(parsePhoneRequest(vector.message)).toEqual(vector.message)
})

test('sealing and opening the pair request and its reply give the vector’s envelopes', () => {
  expect(seal(vector.message, mac.publicKey, phone, bytes(vector.nonce))).toBe(vector.envelope)
  expect(unseal(vector.envelope, mac)).toEqual({
    from: vector.phonePublicKey,
    nonce: vector.nonce,
    message: vector.message,
  })
  expect(seal(vector.reply, phone.publicKey, mac, bytes(vector.replyNonce))).toBe(
    vector.replyEnvelope,
  )
  expect(unseal(vector.replyEnvelope, phone)?.message).toEqual(vector.reply)
  expect(unseal(vector.envelope, phone)).toBeUndefined()
})
