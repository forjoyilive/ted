import { randomBytes } from 'node:crypto'
import {
  type DaemonClient,
  encodePairingLink,
  type MacReply,
  type MacToRelay,
  pairingLifetimeMs,
  phoneProtocolVersion,
  readDaemonInfo,
  relayListHash,
  toBase64Url,
} from '@ted/protocol'
import { afterAll, beforeAll, expect, expectTypeOf, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/daemon.ts'
import type { PhonesArea, TedStore } from '../src/store/index.ts'
import { appClient, killRunHosts, makeTempHome, stubClaudePath } from './helpers.ts'
import {
  memoryKeyrings,
  RelayRefused,
  type RelayStub,
  startRelayStub,
  TestPhone,
  ticketHashOf,
} from './support/phone-relay.ts'

expectTypeOf<TedStore>().toExtend<PhonesArea>()

const macName = 'Studio Mac'
let home: string
let cleanup: () => Promise<void>
let relay: RelayStub
let daemon: RunningDaemon
let client: DaemonClient
let offset = 0
const now = () => Date.now() + offset
const phones: TestPhone[] = []
let approvedPhone: TestPhone

beforeAll(async () => {
  ;({ home, cleanup } = await makeTempHome())
  relay = await startRelayStub()
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    phones: {
      keyrings: memoryKeyrings().keyrings,
      relayUrl: relay.url,
      now,
      macName: async () => macName,
      relayDelaysMs: [50],
    },
  })
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('No daemon.json')
  client = appClient(info, daemon.appToken)
})

afterAll(async () => {
  for (const phone of phones) phone.close()
  await daemon?.stop()
  await relay?.close()
  await killRunHosts(home)
  await cleanup()
})

async function newPhone(): Promise<TestPhone> {
  const offer = await client.createPhonePairing()
  const phone = new TestPhone(offer.link, { now })
  phones.push(phone)
  await phone.online
  return phone
}

function failure(reply: MacReply): string | undefined {
  return reply.ok ? undefined : reply.error.code
}

const ended = (phone: TestPhone) => (frame: MacToRelay) =>
  frame.t === 'pairing-end' && frame.hash === ticketHashOf(phone.link)

test('a phone pairs over a signed login, the user approves it, and it reads status', async () => {
  const phone = await newPhone()
  approvedPhone = phone
  const hash = ticketHashOf(phone.link)
  expect(
    relay.frames.some(
      ({ from, text }) => from === 'relay' && text.includes('"pairing-ok"') && text.includes(hash),
    ),
  ).toBe(true)
  expect(relay.logins).toContainEqual({ mode: 'mac', route: 'mac', status: 200 })
  expect(relay.logins).toContainEqual({ mode: 'pairing', route: 'phone', status: 200 })
  expect(relay.list(phone.link.channel)).toEqual({ rev: 0, keys: [] })
  expect(await client.currentPhonePairing()).toMatchObject({ state: 'live' })
  const paired = await phone.pair('iPhone 16')
  expect(paired).toMatchObject({ ok: true, body: { state: 'waiting' } })
  const code = paired.ok ? paired.body.code : ''
  expect(code).toMatch(/^\d{6}$/)
  await relay.macFrame(
    (frame) =>
      frame.t === 'pairing-candidate' && frame.hash === hash && frame.key === phone.relayKey(),
  )
  const pairing = await client.currentPhonePairing()
  expect(pairing).toMatchObject({ state: 'waiting', phoneName: 'iPhone 16', code })
  expect(await phone.pairStatus()).toMatchObject({ ok: true, body: { state: 'waiting' } })

  await client.approvePhonePairing({ pairing: phone.link.pairing })
  await phone.approved()
  expect(relay.list(phone.link.channel)).toEqual({ rev: 1, keys: [phone.relayKey()] })
  expect(await relay.macFrame((frame) => frame.t === 'phones' && frame.rev === 1)).toMatchObject({
    base: relayListHash(0, []),
  })
  expect(relay.frames.find(({ text }) => text.includes('"phones"'))?.text).toContain('"base":null')
  await relay.macFrame(ended(phone))
  expect(await phone.status()).toMatchObject({
    ok: true,
    body: { mac: macName, edition: 'dev', version: '9.9.9', protocol: phoneProtocolVersion },
  })
  expect(
    await phone.send({ type: 'pair-status', pairing: toBase64Url(randomBytes(16)) }),
  ).toMatchObject({ ok: true, body: { state: 'expired' } })
  expect(relay.logins).toContainEqual({ mode: 'phone', route: 'phone', status: 200 })
  const { phones: listed, pairAgain } = await client.pairedPhones()
  expect(pairAgain).toBe(false)
  expect(listed).toEqual([
    expect.objectContaining({ name: 'iPhone 16', lastReachedAt: expect.any(String) }),
  ])
  expect(failure(await phone.send({ type: 'request', route: 'tasks' }))).toBe('unknown-route')
  expect(failure(await phone.status(phoneProtocolVersion + 1))).toBe('too-new')
  expect(failure(await phone.status(2))).toBe('too-old')
  expect(failure(await phone.status(0))).toBe('too-old')
})

test('the phone hears approved only once the relay has the new list, which is sent again after a reconnect', async () => {
  const phone = await newPhone()
  await phone.pair('Late List Phone')
  const listsWithPhone = () =>
    relay.frames.filter(
      ({ from, text }) =>
        from === 'mac' && text.includes('"phones"') && text.includes(phone.relayKey()),
    ).length
  relay.unanswered.add('phones')
  try {
    await client.approvePhonePairing({ pairing: phone.link.pairing })
    await expect.poll(listsWithPhone).toBe(1)
    expect(await phone.pairStatus()).toMatchObject({ ok: true, body: { state: 'waiting' } })
    expect(relay.list(phone.link.channel)?.keys).not.toContain(phone.relayKey())
  } finally {
    relay.unanswered.delete('phones')
  }
  relay.dropMac()
  await expect.poll(listsWithPhone).toBe(2)
  await phone.approved()
  expect(relay.list(phone.link.channel)?.keys).toContain(phone.relayKey())
})

test('a pair with a bad relay key proof, or a relay key another phone has, is refused', async () => {
  const forged = await newPhone()
  const other = new TestPhone(encodePairingLink(forged.link))
  expect(
    failure(
      await forged.pair('Forged', 'dev', phoneProtocolVersion, { relayProof: other.relayProof() }),
    ),
  ).toBe('bad-request')
  expect(await client.currentPhonePairing()).toMatchObject({ state: 'expired' })

  const offer = await client.createPhonePairing()
  const copy = new TestPhone(offer.link, { now, relayKeys: approvedPhone.relayKeys })
  phones.push(copy)
  expect(failure(await copy.pair('Copy'))).toBe('bad-request')
  expect(await client.currentPhonePairing()).toMatchObject({ state: 'expired' })
})

test('the current pairing shows no link until the relay takes the ticket', async () => {
  const pairingFrames = () =>
    relay.frames.filter(({ from, text }) => from === 'mac' && text.startsWith('{"t":"pairing",'))
      .length
  const before = pairingFrames()
  relay.unanswered.add('pairing')
  const offered = client.createPhonePairing()
  try {
    await expect.poll(pairingFrames).toBe(before + 1)
    expect(await client.currentPhonePairing()).toEqual({ state: 'none' })
  } finally {
    relay.unanswered.delete('pairing')
  }
  relay.dropMac()
  const offer = await offered
  expect(await client.currentPhonePairing()).toMatchObject({ state: 'live', link: offer.link })
  await client.cancelPhonePairing()
})

test('a cancelled or replaced link ends its ticket at once', async () => {
  const replaced = await newPhone()
  const cancelled = await newPhone()
  await relay.macFrame(ended(replaced))
  await expect.poll(() => replaced.closes).toContain(4403)
  await client.cancelPhonePairing()
  await relay.macFrame(ended(cancelled))
  await expect.poll(() => cancelled.closes).toContain(4403)
  await expect(cancelled.pair()).rejects.toThrow(RelayRefused)
})

test('a used code is refused, and an expired one too', async () => {
  const phone = await newPhone()
  expect(await phone.pair()).toMatchObject({ ok: true })
  const second = new TestPhone(encodePairingLink(phone.link), { now })
  const secondPair = await second.send(
    {
      type: 'pair',
      pairing: second.link.pairing,
      secret: second.link.secret,
      name: 'Second',
      edition: 'dev',
      relayKey: second.relayKey(),
      relayProof: second.relayProof(),
    },
    phoneProtocolVersion,
    phone,
  )
  expect(failure(secondPair)).toBe('used')
  await client.refusePhonePairing({ pairing: phone.link.pairing })
  expect(await phone.pairStatus()).toMatchObject({ ok: true, body: { state: 'refused' } })
  await relay.macFrame(ended(phone))

  const late = await newPhone()
  offset = pairingLifetimeMs + 1_000
  try {
    expect(failure(await late.pair())).toBe('expired')
    expect(await client.currentPhonePairing()).toMatchObject({ state: 'expired' })
  } finally {
    offset = 0
  }
  await client.cancelPhonePairing()
  expect(await client.currentPhonePairing()).toEqual({ state: 'none' })
})

test('a phone of the other edition or protocol is refused, and the code is used up', async () => {
  for (const [edition, protocol, code] of [
    ['release', phoneProtocolVersion, 'wrong-edition'],
    ['dev', 2, 'too-old'],
    ['dev', phoneProtocolVersion + 1, 'too-new'],
  ] as const) {
    const phone = await newPhone()
    expect(failure(await phone.pair('Other Phone', edition, protocol)), code).toBe(code)
    expect(failure(await phone.pair()), code).toBe('used')
    expect(await client.currentPhonePairing()).toMatchObject({ state: 'expired' })
  }
})

test('a removed phone is shut out by the relay at once, gets not-paired, and a replayed envelope is dropped', async () => {
  const phone = await newPhone()
  await phone.pair('Removed Phone')
  await client.approvePhonePairing({ pairing: phone.link.pairing })
  await phone.approved()
  const { id, envelope } = phone.message({ type: 'request', route: 'status' })
  expect(await phone.ask(id, envelope)).toMatchObject({ ok: true })
  await phone.sendRaw(envelope)
  expect(await phone.status()).toMatchObject({ ok: true })
  expect(phone.replies.filter((reply) => reply.id === id)).toHaveLength(1)

  const stale = phone.message({ type: 'request', route: 'status' })
  offset = -150_000
  const old = phone.message({ type: 'request', route: 'status' })
  offset = 0
  await phone.sendRaw(old.envelope)
  expect(await phone.ask(stale.id, stale.envelope)).toMatchObject({ ok: true })
  expect(phone.replies.some((reply) => reply.id === old.id)).toBe(false)

  const removed = (await client.pairedPhones()).phones.find((p) => p.name === 'Removed Phone')
  if (!removed) throw new Error('phone not listed')
  await client.removePhone(removed.id)
  await expect.poll(() => phone.pairedCloses).toContain(4403)
  expect(relay.list(phone.link.channel)?.keys).not.toContain(phone.relayKey())
  await expect(phone.status()).rejects.toThrow(RelayRefused)
  expect(
    failure(
      await phone.send({ type: 'request', route: 'status' }, phoneProtocolVersion, approvedPhone),
    ),
  ).toBe('not-paired')
  expect(
    await phone.send(
      { type: 'pair-status', pairing: phone.link.pairing },
      phoneProtocolVersion,
      approvedPhone,
    ),
  ).toMatchObject({ ok: true, body: { state: 'expired' } })
})

test('the relay sees only ciphertext', async () => {
  const secrets = phones.map((phone) => phone.link.secret)
  const names = ['iPhone 16', 'Test Phone', 'Removed Phone', 'Other Phone', macName]
  for (const { text } of relay.frames) {
    for (const value of [...secrets, ...names]) expect(text).not.toContain(value)
    const frame = JSON.parse(text) as { t: string; data?: string }
    if (frame.data === undefined) continue
    expect(frame.data).not.toMatch(/"(type|protocol|pairing|secret|route|name|state|mac)"/)
  }
  expect(relay.frames.some(({ from }) => from === 'phone')).toBe(true)
  expect(relay.frames.some(({ from, text }) => from === 'mac' && text.includes('"msg"'))).toBe(true)
})
