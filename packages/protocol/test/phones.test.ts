import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  sign as signBytes,
  verify,
} from 'node:crypto'
import { expect, test } from 'vitest'
import type { JsonObject } from '../src/parse.ts'
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
  parseRelayAuth,
  parseRelayToMac,
  parseRelayToPhone,
  phoneErrorCodes,
  phoneProtocolVersion,
  relayAuth,
  relayChannel,
  relayKeyProofText,
  relayListHash,
  relayLoginText,
  relayTicket,
  relayTicketHash,
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
  expect(phoneProtocolVersion).toBe(3)
  expect(minPhoneProtocolVersion).toBe(3)
  expect(defaultRelayUrl).toBe('https://ted-relay.forjoyilive.workers.dev')
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
  const relayPair = { ...pair, relayKey: b(32), relayProof: b(64) }
  expect(parsePhoneRequest(relayPair)).toEqual(relayPair)
  expect(parsePhoneRequest({ ...pair, name: '  iPhone 16  ' })).toMatchObject({ name: 'iPhone 16' })
  for (const [field, value] of [
    ['pairing', b(32)],
    ['secret', 'x'],
    ['name', ''],
    ['name', 'x'.repeat(101)],
    ['edition', 'beta'],
    ['relayKey', b(31)],
    ['relayKey', 7],
    ['relayProof', b(32)],
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
  const pushToken = {
    ...header,
    type: 'request',
    route: 'push-token',
    token: 'ExponentPushToken[aB3_-x]',
  }
  expect(parsePhoneRequest(pushToken)).toEqual(pushToken)
  expect(parsePhoneRequest({ ...pushToken, token: 'ExpoPushToken[aB3]' })).toMatchObject({
    token: 'ExpoPushToken[aB3]',
  })
  for (const token of [
    undefined,
    7,
    '',
    'ExponentPushToken[]',
    'ExponentPushToken[a b]',
    'ExponentPushToken[abc] ',
    'apns:abc',
    `ExponentPushToken[${'a'.repeat(201)}]`,
  ]) {
    expect(() => parsePhoneRequest({ ...pushToken, token }), String(token)).toThrow(/token/)
  }
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
  const hash = b(32)
  const key = b(32)
  expect(parseRelayToMac({ t: 'ready' })).toEqual({ t: 'ready' })
  expect(parseRelayToMac({ t: 'msg', conn: 3, data: 'd' })).toEqual({
    t: 'msg',
    conn: 3,
    data: 'd',
  })
  expect(parseRelayToMac({ t: 'closed', conn: 3 })).toEqual({ t: 'closed', conn: 3 })
  for (const t of ['phones-ok', 'phones-stale', 'phones-conflict']) {
    expect(parseRelayToMac({ t, rev: 4 })).toEqual({ t, rev: 4 })
  }
  for (const t of ['pairing-ok', 'pairing-candidate-ok', 'pairing-gone', 'pairing-end-ok']) {
    expect(parseRelayToMac({ t, hash })).toEqual({ t, hash })
  }
  for (const frame of [
    { t: 'challenge', nonce: 'n' },
    { t: 'msg', conn: '3', data: 'd' },
    { t: 'msg', conn: 3, data: {} },
    { t: 'closed' },
    { t: 'phones-ok', rev: '4' },
    { t: 'pairing-ok', hash: b(16) },
    { t: 'pairing-gone' },
    { t: 'other' },
    'ready',
  ]) {
    expect(parseRelayToMac(frame)).toBeUndefined()
  }
  expect(parseMacToRelay({ t: 'msg', conn: 1, data: 'd' })).toEqual({
    t: 'msg',
    conn: 1,
    data: 'd',
  })
  expect(parseMacToRelay({ t: 'phones', rev: 2, keys: [key], base: hash })).toEqual({
    t: 'phones',
    rev: 2,
    keys: [key],
    base: hash,
  })
  expect(parseMacToRelay({ t: 'phones', rev: 0, keys: [], base: null })).toEqual({
    t: 'phones',
    rev: 0,
    keys: [],
    base: null,
  })
  expect(parseMacToRelay({ t: 'pairing', hash, expiresAt: 1795135669031 })).toEqual({
    t: 'pairing',
    hash,
    expiresAt: 1795135669031,
  })
  expect(parseMacToRelay({ t: 'pairing-candidate', hash, key })).toEqual({
    t: 'pairing-candidate',
    hash,
    key,
  })
  expect(parseMacToRelay({ t: 'pairing-end', hash })).toEqual({ t: 'pairing-end', hash })
  for (const frame of [
    { t: 'login', key: 'k', sig: 's' },
    { t: 'phones', rev: -1, keys: [], base: null },
    { t: 'phones', rev: 1, keys: ['short'], base: null },
    { t: 'phones', rev: 1, keys: Array.from({ length: 65 }, () => b(32)), base: null },
    { t: 'phones', rev: 1, base: null },
    { t: 'phones', rev: 1, keys: [] },
    { t: 'phones', rev: 1, keys: [], base: 'short' },
    { t: 'phones', rev: 1, keys: [key, key], base: null },
    { t: 'pairing', hash },
    { t: 'pairing', hash: 'x', expiresAt: 1 },
    { t: 'pairing-candidate', hash, key: b(16) },
    { t: 'pairing-end' },
  ]) {
    expect(parseMacToRelay(frame)).toBeUndefined()
  }
  expect(parseRelayToPhone({ t: 'msg', data: 'd' })).toEqual({ t: 'msg', data: 'd' })
  expect(parseRelayToPhone({ t: 'mac-online' })).toEqual({ t: 'mac-online' })
  expect(parseRelayToPhone({ t: 'mac-offline' })).toEqual({ t: 'mac-offline' })
  expect(parseRelayToPhone({ t: 'msg' })).toBeUndefined()
  expect(parseRelayToPhone({ t: 'ready' })).toBeUndefined()
})

test('the login header is signed over every field and parses back', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pair = {
    publicKey: fromBase64Url(publicKey.export({ format: 'jwk' }).x ?? '', 32) ?? new Uint8Array(),
  }
  const sign = (text: Uint8Array) => new Uint8Array(signBytes(null, text, privateKey))
  const ticket = randomBytes(32)
  const nonce = b(16)
  const channel = b(32)
  const header = relayAuth({
    mode: 'pairing',
    route: 'phone',
    host: 'relay.example:8443',
    channel,
    at: 1795135669031,
    nonce,
    key: pair.publicKey,
    ticket,
    sign,
  })
  expect(header.length).toBeLessThanOrEqual(1024)
  const login = parseRelayAuth(header)
  const ticketHash = toBase64Url(createHash('sha256').update(ticket).digest())
  expect(login).toEqual({
    v: 2,
    mode: 'pairing',
    key: toBase64Url(pair.publicKey),
    at: 1795135669031,
    nonce,
    sig: login.sig,
    ticket: toBase64Url(ticket),
  })
  const text = `ted-relay-login:v2:pairing:phone:relay.example:8443:${channel}:1795135669031:${nonce}:${ticketHash}`
  expect(
    relayLoginText({
      mode: 'pairing',
      route: 'phone',
      host: 'relay.example:8443',
      channel,
      at: 1795135669031,
      nonce,
      ticketHash,
    }),
  ).toBe(text)
  expect(
    verify(null, new TextEncoder().encode(text), publicKey, Buffer.from(login.sig, 'base64url')),
  ).toBe(true)

  const mac = parseRelayAuth(
    relayAuth({
      mode: 'mac',
      route: 'mac',
      host: 'h',
      channel,
      at: 1,
      nonce,
      key: pair.publicKey,
      sign,
    }),
  )
  expect(mac).toEqual({
    v: 2,
    mode: 'mac',
    key: toBase64Url(pair.publicKey),
    at: 1,
    nonce,
    sig: mac.sig,
  })
  expect(relayLoginText({ mode: 'mac', route: 'mac', host: 'h', channel, at: 1, nonce })).toBe(
    `ted-relay-login:v2:mac:mac:h:${channel}:1:${nonce}:-`,
  )

  const encode = (value: JsonObject) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const good = { v: 2, mode: 'phone', key: b(32), at: 1, nonce: b(16), sig: b(64) }
  expect(parseRelayAuth(encode(good))).toEqual(good)
  for (const [field, value] of [
    ['v', '2'],
    ['mode', 'admin'],
    ['key', b(31)],
    ['at', 1.5],
    ['nonce', b(32)],
    ['sig', b(32)],
    ['ticket', b(32)],
  ] as const) {
    expect(() => parseRelayAuth(encode({ ...good, [field]: value })), field).toThrow()
  }
  expect(() => parseRelayAuth(encode({ ...good, mode: 'pairing' }))).toThrow(/ticket/)
  expect(() => parseRelayAuth(encode({ ...good, mode: 'pairing', ticket: b(16) }))).toThrow()
  expect(() => parseRelayAuth('a'.repeat(1025))).toThrow(/1024/)
  expect(() => parseRelayAuth('!!')).toThrow()
})

test('the pairing ticket, its hash and the relay key proof text', () => {
  const secret = randomBytes(32)
  const ticket = relayTicket(secret, 'chan', 'pair')
  expect(Buffer.from(ticket)).toEqual(
    createHmac('sha256', secret).update('ted-relay-pairing:v1:chan:pair').digest(),
  )
  expect(relayTicketHash(ticket)).toBe(toBase64Url(createHash('sha256').update(ticket).digest()))
  expect(relayKeyProofText('pair', 'box')).toBe('ted-relay-key:v1:pair:box')
  expect(relayListHash(3, ['b', 'a'])).toBe(
    toBase64Url(createHash('sha256').update('3:a,b').digest()),
  )
  expect(relayListHash(3, ['a', 'b'])).toBe(relayListHash(3, ['b', 'a']))
  expect(relayListHash(0, [])).toBe(toBase64Url(createHash('sha256').update('0:').digest()))
})

test('channel, login text and short code', () => {
  const key = new Uint8Array(32).fill(7)
  expect(relayChannel(key)).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(relayChannel(key)).toBe(relayChannel(new Uint8Array(32).fill(7)))
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
