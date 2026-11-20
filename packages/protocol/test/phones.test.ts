import { randomBytes } from 'node:crypto'
import { expect, test } from 'vitest'
import {
  defaultRelayUrl,
  devRelayUrl,
  encodePairingLink,
  fromBase64Url,
  minPhoneProtocolVersion,
  type PairingLink,
  parseMacReply,
  parseMacToRelay,
  parsePairingLink,
  parsePhoneEnvelope,
  parsePhoneMessageHeader,
  parsePhonePairingDecision,
  parsePhoneRequest,
  parseRelayToMac,
  parseRelayToPhone,
  phoneErrorCodes,
  phoneProtocolVersion,
  relayChannel,
  relayLoginText,
  relayUrl,
  shortCode,
  toBase64Url,
} from '../src/phones.ts'

const b = (length: number) => toBase64Url(randomBytes(length))

const link: PairingLink = {
  v: 1,
  edition: 'dev',
  relay: 'http://127.0.0.1:8787',
  channel: b(32),
  macKey: b(32),
  pairing: b(16),
  secret: b(32),
  expiresAt: 1795135669031,
}

const header = { protocol: 1, id: b(16), at: 1795135669031 }

test('versions and relay addresses', () => {
  expect(phoneProtocolVersion).toBe(2)
  expect(minPhoneProtocolVersion).toBe(1)
  expect(defaultRelayUrl).toBe('https://ted-relay.invalid')
  expect(relayUrl({}, 'dev')).toBe(devRelayUrl)
  expect(relayUrl({}, 'release')).toBe(defaultRelayUrl)
  expect(relayUrl({ TED_RELAY_URL: 'http://127.0.0.1:9999' }, 'dev')).toBe('http://127.0.0.1:9999')
  expect(relayUrl({ TED_RELAY_URL: 'http://127.0.0.1:9999' }, 'release')).toBe(defaultRelayUrl)
})

test('base64url is strict about characters, padding and length', () => {
  const bytes = randomBytes(32)
  const text = toBase64Url(bytes)
  expect(text).not.toMatch(/[=+/]/)
  expect(fromBase64Url(text, 32)).toEqual(new Uint8Array(bytes))
  expect(fromBase64Url(text, 16)).toBeUndefined()
  expect(fromBase64Url(`${text}=`)).toBeUndefined()
  expect(fromBase64Url('ab+/')).toBeUndefined()
})

test('a pairing link round-trips every field', () => {
  const text = encodePairingLink(link)
  expect(text.startsWith('ted-pair:')).toBe(true)
  expect(parsePairingLink(text)).toEqual(link)
})

test('a pairing link refuses a wrong prefix, bad JSON and each bad field', () => {
  expect(() => parsePairingLink('ted-pairing:abc')).toThrow(/ted-pair:/)
  expect(() => parsePairingLink('ted-pair:!!!')).toThrow()
  expect(() => parsePairingLink(`ted-pair:${toBase64Url(Buffer.from('not json'))}`)).toThrow()
  const bad: [keyof PairingLink, unknown][] = [
    ['v', '1'],
    ['edition', 'beta'],
    ['relay', 'ftp://relay.example'],
    ['relay', 'not a url'],
    ['channel', b(31)],
    ['macKey', 'short'],
    ['pairing', b(32)],
    ['secret', b(16)],
    ['expiresAt', 1.5],
  ]
  for (const [field, value] of bad) {
    const text = `ted-pair:${toBase64Url(Buffer.from(JSON.stringify({ ...link, [field]: value })))}`
    expect(() => parsePairingLink(text), field).toThrow()
  }
})

test('envelopes need every field at its length', () => {
  const envelope = { v: 1, from: b(32), nonce: b(24), box: b(80) }
  expect(parsePhoneEnvelope(envelope)).toEqual(envelope)
  for (const [field, value] of [
    ['v', 'one'],
    ['from', b(31)],
    ['nonce', b(32)],
    ['box', 3],
  ] as const) {
    expect(() => parsePhoneEnvelope({ ...envelope, [field]: value }), field).toThrow()
  }
  expect(() => parsePhoneEnvelope('text')).toThrow()
})

test('message headers and phone requests', () => {
  expect(parsePhoneMessageHeader({ ...header, type: 'anything' })).toEqual({
    ...header,
    type: 'anything',
  })
  for (const [field, value] of [
    ['protocol', '1'],
    ['id', b(15)],
    ['at', 'now'],
    ['type', 4],
  ] as const) {
    expect(() => parsePhoneMessageHeader({ ...header, type: 'x', [field]: value }), field).toThrow()
  }
  const pair = {
    ...header,
    type: 'pair',
    pairing: b(16),
    secret: b(32),
    name: 'iPhone 16',
    edition: 'release',
  }
  expect(parsePhoneRequest(pair)).toEqual(pair)
  expect(parsePhoneRequest({ ...pair, name: '  iPhone 16  ' })).toMatchObject({ name: 'iPhone 16' })
  for (const [field, value] of [
    ['pairing', b(32)],
    ['secret', 'x'],
    ['name', ''],
    ['name', 'x'.repeat(101)],
    ['edition', 'beta'],
  ] as const) {
    expect(() => parsePhoneRequest({ ...pair, [field]: value }), field).toThrow()
  }
  const status = { ...header, type: 'pair-status', pairing: b(16) }
  expect(parsePhoneRequest(status)).toEqual(status)
  expect(() => parsePhoneRequest({ ...status, pairing: 'x' })).toThrow()
  const request = { ...header, type: 'request', route: 'status' }
  expect(parsePhoneRequest(request)).toEqual(request)
  expect(() => parsePhoneRequest({ ...request, route: 1 })).toThrow()
  const read = { ...header, type: 'request', route: 'request', requestId: 'c-1' }
  expect(parsePhoneRequest(read)).toEqual(read)
  expect(() => parsePhoneRequest({ ...read, requestId: undefined })).toThrow(/requestId/)
  expect(() => parsePhoneRequest({ ...read, requestId: '' })).toThrow(/requestId/)
  expect(() => parsePhoneRequest({ ...read, requestId: 'x'.repeat(201) })).toThrow(/requestId/)
  const answer = {
    ...header,
    type: 'request',
    route: 'answer',
    requestId: 'c-1',
    answer: { action: 'answer', choice: 'Yes', text: 'and soon' },
  }
  expect(parsePhoneRequest(answer)).toEqual(answer)
  expect(() => parsePhoneRequest({ ...answer, answer: undefined })).toThrow()
  expect(() => parsePhoneRequest({ ...answer, answer: { action: 'merge' } })).toThrow()
  expect(() => parsePhoneRequest({ ...answer, requestId: 3 })).toThrow(/requestId/)
  expect(parsePhoneRequest({ ...request, route: 'requests', requestId: 'ignored' })).toEqual({
    ...request,
    route: 'requests',
  })
  expect(() => parsePhoneRequest({ ...header, type: 'reply' })).toThrow()
})

test('Mac replies carry a body or a known error code', () => {
  const ok = { ...header, type: 'reply', ok: true, body: { state: 'waiting', code: '482913' } }
  expect(parseMacReply(ok)).toEqual(ok)
  for (const code of phoneErrorCodes) {
    const failed = { ...header, type: 'reply', ok: false, error: { code, message: 'Plain.' } }
    expect(parseMacReply(failed)).toEqual(failed)
  }
  expect(() =>
    parseMacReply({ ...header, type: 'reply', ok: false, error: { code: 'nope', message: '' } }),
  ).toThrow()
  expect(() => parseMacReply({ ...ok, type: 'pair' })).toThrow()
  expect(() => parseMacReply({ ...ok, ok: 'yes' })).toThrow()
  expect(() => parseMacReply({ ...ok, body: 'text' })).toThrow()
  expect(() =>
    parseMacReply({ ...header, type: 'reply', ok: false, error: { code: 'used' } }),
  ).toThrow()
})

test('relay frames', () => {
  expect(parseRelayToMac({ t: 'challenge', nonce: 'n' })).toEqual({ t: 'challenge', nonce: 'n' })
  expect(parseRelayToMac({ t: 'ready' })).toEqual({ t: 'ready' })
  expect(parseRelayToMac({ t: 'msg', conn: 3, data: 'd' })).toEqual({
    t: 'msg',
    conn: 3,
    data: 'd',
  })
  expect(parseRelayToMac({ t: 'closed', conn: 3 })).toEqual({ t: 'closed', conn: 3 })
  for (const frame of [
    { t: 'challenge' },
    { t: 'msg', conn: '3', data: 'd' },
    { t: 'msg', conn: 3, data: {} },
    { t: 'closed' },
    { t: 'other' },
    'ready',
  ]) {
    expect(parseRelayToMac(frame)).toBeUndefined()
  }
  expect(parseMacToRelay({ t: 'login', key: 'k', sig: 's' })).toEqual({
    t: 'login',
    key: 'k',
    sig: 's',
  })
  expect(parseMacToRelay({ t: 'msg', conn: 1, data: 'd' })).toEqual({
    t: 'msg',
    conn: 1,
    data: 'd',
  })
  expect(parseMacToRelay({ t: 'login', key: 'k' })).toBeUndefined()
  expect(parseRelayToPhone({ t: 'msg', data: 'd' })).toEqual({ t: 'msg', data: 'd' })
  expect(parseRelayToPhone({ t: 'mac-online' })).toEqual({ t: 'mac-online' })
  expect(parseRelayToPhone({ t: 'mac-offline' })).toEqual({ t: 'mac-offline' })
  expect(parseRelayToPhone({ t: 'msg' })).toBeUndefined()
  expect(parseRelayToPhone({ t: 'ready' })).toBeUndefined()
})

test('channel, login text and short code', () => {
  const key = new Uint8Array(32).fill(7)
  expect(relayChannel(key)).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(relayChannel(key)).toBe(relayChannel(new Uint8Array(32).fill(7)))
  expect(relayLoginText('chan', 'nonce')).toBe('ted-relay-login:v1:chan:nonce')
  const code = shortCode(new Uint8Array(32), new Uint8Array(32).fill(1), new Uint8Array(32).fill(2))
  expect(code).toMatch(/^\d{6}$/)
  expect(
    shortCode(new Uint8Array(32), new Uint8Array(32).fill(1), new Uint8Array(32).fill(3)),
  ).not.toBe(code)
})

test('pairing decisions name a pairing ID', () => {
  const pairing = b(16)
  expect(parsePhonePairingDecision({ pairing })).toEqual({ pairing })
  expect(() => parsePhonePairingDecision({ pairing: 'x' })).toThrow(/pairing ID/)
  expect(() => parsePhonePairingDecision({})).toThrow(/pairing must be text/)
  expect(() => parsePhonePairingDecision(null)).toThrow(/object/)
})
