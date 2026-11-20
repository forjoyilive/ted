import {
  type DaemonClient,
  type MacReply,
  pairingLifetimeMs,
  phoneProtocolVersion,
  readDaemonInfo,
} from '@ted/protocol'
import { afterAll, beforeAll, expect, expectTypeOf, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/daemon.ts'
import type { PhonesArea, TedStore } from '../src/store/index.ts'
import { appClient, killRunHosts, makeTempHome, stubClaudePath } from './helpers.ts'
import { memoryKeyrings, type RelayStub, startRelayStub, TestPhone } from './support/phone-relay.ts'

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

test('a phone pairs, the user approves it, and it reads status', async () => {
  const phone = await newPhone()
  expect(await client.currentPhonePairing()).toMatchObject({ state: 'live' })
  const paired = await phone.pair('iPhone 16')
  expect(paired).toMatchObject({ ok: true, body: { state: 'waiting' } })
  const code = paired.ok ? paired.body.code : ''
  expect(code).toMatch(/^\d{6}$/)
  const pairing = await client.currentPhonePairing()
  expect(pairing).toMatchObject({ state: 'waiting', phoneName: 'iPhone 16', code })
  expect(await phone.send({ type: 'pair-status', pairing: phone.link.pairing })).toMatchObject({
    ok: true,
    body: { state: 'waiting' },
  })
  expect(failure(await phone.status())).toBe('not-paired')

  await client.approvePhonePairing({ pairing: phone.link.pairing })
  expect(await phone.send({ type: 'pair-status', pairing: phone.link.pairing })).toMatchObject({
    ok: true,
    body: { state: 'approved', mac: macName },
  })
  expect(await phone.status()).toMatchObject({
    ok: true,
    body: { mac: macName, edition: 'dev', version: '9.9.9', protocol: phoneProtocolVersion },
  })
  expect(await phone.status(1)).toMatchObject({
    ok: true,
    body: { mac: macName, protocol: phoneProtocolVersion },
  })
  const { phones: listed } = await client.pairedPhones()
  expect(listed).toEqual([
    expect.objectContaining({ name: 'iPhone 16', lastReachedAt: expect.any(String) }),
  ])
  expect(failure(await phone.send({ type: 'request', route: 'tasks' }))).toBe('unknown-route')
  expect(failure(await phone.status(phoneProtocolVersion + 1))).toBe('too-new')
  expect(failure(await phone.status(0))).toBe('too-old')
})

test('a used code is refused, and an expired one too', async () => {
  const phone = await newPhone()
  expect(await phone.pair()).toMatchObject({ ok: true })
  const second = new TestPhone(
    `ted-pair:${Buffer.from(JSON.stringify(phone.link)).toString('base64url')}`,
    {
      now,
    },
  )
  phones.push(second)
  expect(failure(await second.pair())).toBe('used')
  expect(failure(await phone.pair())).toBe('used')
  await client.refusePhonePairing({ pairing: phone.link.pairing })
  expect(await phone.send({ type: 'pair-status', pairing: phone.link.pairing })).toMatchObject({
    ok: true,
    body: { state: 'refused' },
  })

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
    ['release', 1, 'wrong-edition'],
    ['dev', 0, 'too-old'],
    ['dev', phoneProtocolVersion + 1, 'too-new'],
  ] as const) {
    const phone = await newPhone()
    expect(failure(await phone.pair('Other Phone', edition, protocol)), code).toBe(code)
    expect(failure(await phone.pair()), code).toBe('used')
    expect(await client.currentPhonePairing()).toMatchObject({ state: 'expired' })
  }
})

test('a removed phone gets not-paired at once, and a replayed envelope is dropped', async () => {
  const phone = await newPhone()
  await phone.pair('Removed Phone')
  await client.approvePhonePairing({ pairing: phone.link.pairing })
  const { id, envelope } = phone.message({ type: 'request', route: 'status' })
  expect(await phone.ask(id, envelope)).toMatchObject({ ok: true })
  phone.sendRaw(envelope)
  expect(await phone.status()).toMatchObject({ ok: true })
  expect(phone.replies.filter((reply) => reply.id === id)).toHaveLength(1)

  const stale = phone.message({ type: 'request', route: 'status' })
  offset = -150_000
  const old = phone.message({ type: 'request', route: 'status' })
  offset = 0
  phone.sendRaw(old.envelope)
  expect(await phone.ask(stale.id, stale.envelope)).toMatchObject({ ok: true })
  expect(phone.replies.some((reply) => reply.id === old.id)).toBe(false)

  const removed = (await client.pairedPhones()).phones.find((p) => p.name === 'Removed Phone')
  if (!removed) throw new Error('phone not listed')
  await client.removePhone(removed.id)
  expect(failure(await phone.status())).toBe('not-paired')
  expect(failure(await phone.send({ type: 'pair-status', pairing: phone.link.pairing }))).toBe(
    undefined,
  )
})

test('the relay sees only ciphertext', async () => {
  const secrets = phones.map((phone) => phone.link.secret)
  const names = ['iPhone 16', 'Test Phone', 'Removed Phone', 'Other Phone', macName]
  for (const { text } of relay.frames) {
    for (const value of [...secrets, ...names]) expect(text).not.toContain(value)
    expect(text).not.toMatch(/\\?"(type|protocol|pairing|secret|route|name|state|mac)\\?"/)
  }
  expect(relay.frames.some(({ from }) => from === 'phone')).toBe(true)
  expect(relay.frames.some(({ from, text }) => from === 'mac' && text.includes('"msg"'))).toBe(true)
})
