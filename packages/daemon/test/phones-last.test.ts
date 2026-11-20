import { type DaemonClient, readDaemonInfo } from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/daemon.ts'
import { phoneSignKeyAccount } from '../src/phones/keys.ts'
import { appClient, killRunHosts, makeTempHome, stubClaudePath } from './helpers.ts'
import {
  type MemoryKeyrings,
  memoryKeyrings,
  RelayRefused,
  type RelayStub,
  startRelayStub,
  TestPhone,
  ticketHashOf,
} from './support/phone-relay.ts'

let home: string
let cleanup: () => Promise<void>
let relay: RelayStub
let daemon: RunningDaemon | undefined
let client: DaemonClient
let keychain: MemoryKeyrings
const phones: TestPhone[] = []

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  relay = await startRelayStub()
  keychain = memoryKeyrings()
})

async function start(relayAnswerMs?: number): Promise<void> {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    phones: {
      keyrings: keychain.keyrings,
      relayUrl: relay.url,
      macName: async () => 'Studio Mac',
      relayDelaysMs: [50],
      ...(relayAnswerMs !== undefined && { relayAnswerMs }),
    },
  })
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('No daemon.json')
  client = appClient(info, daemon.appToken)
}

afterEach(async () => {
  for (const phone of phones.splice(0)) phone.close()
  await daemon?.stop()
  daemon = undefined
  await relay?.close()
  await killRunHosts(home)
  await cleanup()
})

async function newPhone(): Promise<TestPhone> {
  const offer = await client.createPhonePairing()
  const phone = new TestPhone(offer.link)
  phones.push(phone)
  await phone.online
  return phone
}

async function approvedPhone(name: string): Promise<TestPhone> {
  const phone = await newPhone()
  await phone.pair(name)
  await client.approvePhonePairing({ pairing: phone.link.pairing })
  await phone.approved()
  return phone
}

test('removing the only paired phone sends the relay an empty list, which shuts the phone out', async () => {
  await start()
  const phone = await approvedPhone('Only Phone')
  expect(await phone.status()).toMatchObject({ ok: true })

  const [only] = (await client.pairedPhones()).phones
  if (!only) throw new Error('phone not listed')
  await client.removePhone(only.id)
  expect((await client.pairedPhones()).phones).toEqual([])
  await expect.poll(() => phone.closes).toContain(4403)
  expect(relay.list(phone.link.channel)).toEqual({ rev: 2, keys: [] })
  await expect(phone.status()).rejects.toThrow(RelayRefused)
})

test('a phone refused while no other phone is paired still hears it was refused, then the ticket ends', async () => {
  await start()
  const phone = await newPhone()
  await phone.pair('Refused Phone')
  await client.refusePhonePairing({ pairing: phone.link.pairing })
  expect(await phone.pairStatus()).toMatchObject({ ok: true, body: { state: 'refused' } })
  const hash = ticketHashOf(phone.link)
  await relay.macFrame((frame) => frame.t === 'pairing-end' && frame.hash === hash)
  await expect.poll(() => phone.closes).toContain(4403)
})

test('a relay list newer than this Mac’s makes a new relay key, removes every phone and asks to pair again', async () => {
  await start()
  const first = await approvedPhone('First Phone')
  await approvedPhone('Second Phone')
  const oldChannel = first.link.channel
  const oldKey = keychain.secrets.get(phoneSignKeyAccount)
  relay.storeList(oldChannel, { rev: 50, keys: [first.relayKey()] })
  const [removed] = (await client.pairedPhones()).phones
  if (!removed) throw new Error('phone not listed')
  await client.removePhone(removed.id)

  await expect.poll(async () => (await client.pairedPhones()).pairAgain).toBe(true)
  expect((await client.pairedPhones()).phones).toEqual([])
  expect(keychain.secrets.get(phoneSignKeyAccount)).not.toBe(oldKey)

  const again = await approvedPhone('Paired Again')
  expect(again.link.channel).not.toBe(oldChannel)
  expect(relay.list(again.link.channel)?.keys).toEqual([again.relayKey()])
  expect(await client.pairedPhones()).toMatchObject({
    pairAgain: false,
    phones: [expect.objectContaining({ name: 'Paired Again' })],
  })
  expect(await again.status()).toMatchObject({ ok: true })
})

test('creating a pairing fails when the relay doesn’t take the ticket in time', async () => {
  await start(300)
  relay.unanswered.add('pairing')
  await expect(client.createPhonePairing()).rejects.toThrow('Ted can’t reach the phone relay.')
  await relay.macFrame((frame) => frame.t === 'pairing')
  expect(await client.currentPhonePairing()).toEqual({ state: 'none' })
})
