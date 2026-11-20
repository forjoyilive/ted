import { type DaemonClient, readDaemonInfo, relayListHash, toBase64Url } from '@ted/protocol'
import nacl from 'tweetnacl'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/daemon.ts'
import { phoneSignKeyAccount } from '../src/phones/keys.ts'
import type { PhoneStore } from '../src/store/index.ts'
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

let failAcks = false
let phoneStore: PhoneStore | undefined

async function start(
  phoneOptions: { relayAnswerMs?: number; relayListAckMs?: number } = {},
): Promise<void> {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    phones: {
      keyrings: keychain.keyrings,
      relayUrl: relay.url,
      macName: async () => 'Studio Mac',
      relayDelaysMs: [50],
      ...phoneOptions,
    },
    wrap: {
      store: (opened) => {
        phoneStore = opened.phones
        const record = opened.phones.markRelayAcked
        opened.phones.markRelayAcked = (ack) => {
          if (failAcks) throw new Error('the store refused the write')
          record(ack)
        }
        return opened
      },
    },
  })
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('No daemon.json')
  client = appClient(info, daemon.appToken)
}

afterEach(async () => {
  for (const phone of phones.splice(0)) phone.close()
  failAcks = false
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
  await expect.poll(() => phone.pairedCloses).toContain(4403)
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

function otherRelayKey(): string {
  return toBase64Url(nacl.randomBytes(32))
}

async function removeFirstPhone(): Promise<void> {
  const [removed] = (await client.pairedPhones()).phones
  if (!removed) throw new Error('phone not listed')
  await client.removePhone(removed.id)
}

test('a restored copy whose count passed the relay’s gets a conflict, then a new relay key, no phones and a request to pair again', async () => {
  await start()
  const first = await approvedPhone('First Phone')
  const second = await approvedPhone('Second Phone')
  const oldChannel = first.link.channel
  const oldKey = keychain.secrets.get(phoneSignKeyAccount)
  const acked = relayListHash(2, [first.relayKey(), second.relayKey()])
  relay.storeList(oldChannel, { rev: 2, keys: [otherRelayKey()] })
  await removeFirstPhone()

  const sent = await relay.macFrame((frame) => frame.t === 'phones' && frame.rev === 3)
  expect(sent).toMatchObject({ keys: [second.relayKey()], base: acked })
  await expect.poll(async () => (await client.pairedPhones()).pairAgain).toBe(true)
  expect((await client.pairedPhones()).phones).toEqual([])
  await expect.poll(() => keychain.secrets.get(phoneSignKeyAccount)).not.toBe(oldKey)

  const again = await approvedPhone('Paired Again')
  expect(again.link.channel).not.toBe(oldChannel)
  expect(relay.list(again.link.channel)?.keys).toEqual([again.relayKey()])
  expect(await client.pairedPhones()).toMatchObject({
    pairAgain: false,
    phones: [expect.objectContaining({ name: 'Paired Again' })],
  })
  expect(await again.status()).toMatchObject({ ok: true })
})

test('if the new relay key isn’t made after a reset, it is made before the next pairing', async () => {
  await start()
  const phone = await approvedPhone('Only Phone')
  const oldChannel = phone.link.channel
  const oldKey = keychain.secrets.get(phoneSignKeyAccount)
  keychain.failWrites = true
  relay.storeList(oldChannel, { rev: 1, keys: [otherRelayKey()] })
  await removeFirstPhone()
  await expect.poll(async () => (await client.pairedPhones()).pairAgain).toBe(true)
  expect(keychain.secrets.get(phoneSignKeyAccount)).toBe(oldKey)
  await expect(client.createPhonePairing()).rejects.toThrow(/Keychain/)

  await daemon?.stop()
  keychain.failWrites = false
  await start()
  const offer = await client.createPhonePairing()
  expect(new TestPhone(offer.link).link.channel).not.toBe(oldChannel)
  expect(keychain.secrets.get(phoneSignKeyAccount)).not.toBe(oldKey)
  await client.cancelPhonePairing()
})

test('an unsolicited phones-stale or phones-conflict changes nothing', async () => {
  await start()
  const phone = await approvedPhone('Steady Phone')
  const key = keychain.secrets.get(phoneSignKeyAccount)
  relay.sendToMac({ t: 'phones-stale', rev: 99 })
  relay.sendToMac({ t: 'phones-conflict', rev: 1 })
  expect(await phone.status()).toMatchObject({ ok: true })
  expect(await client.pairedPhones()).toMatchObject({
    pairAgain: false,
    phones: [expect.objectContaining({ name: 'Steady Phone' })],
  })
  expect(keychain.secrets.get(phoneSignKeyAccount)).toBe(key)
})

test('phone messages on a new Mac socket wait for the relay to take the list', async () => {
  await start()
  const phone = await approvedPhone('Gated Phone')
  const lists = () =>
    relay.frames.filter(({ from, text }) => from === 'mac' && text.includes('"phones"')).length
  const forwarded = () =>
    relay.frames.filter(
      ({ from, text }) => from === 'relay' && text.startsWith('{"t":"msg","conn"'),
    ).length
  relay.unanswered.add('phones')
  const before = lists()
  relay.dropMac()
  await expect.poll(lists).toBe(before + 1)
  const early = phone.message({ type: 'request', route: 'status' })
  const sentBefore = forwarded()
  await phone.sendRaw(early.envelope)
  await expect.poll(forwarded).toBeGreaterThan(sentBefore)

  relay.unanswered.delete('phones')
  relay.dropMac()
  await expect.poll(lists).toBe(before + 2)
  expect(await phone.status()).toMatchObject({ ok: true })
  expect(phone.replies.some((reply) => reply.id === early.id)).toBe(false)
})

test('creating a pairing fails when the relay doesn’t take the ticket in time', async () => {
  await start({ relayAnswerMs: 300 })
  relay.unanswered.add('pairing')
  await expect(client.createPhonePairing()).rejects.toThrow('Ted can’t reach the phone relay.')
  await relay.macFrame((frame) => frame.t === 'pairing')
  expect(await client.currentPhonePairing()).toEqual({ state: 'none' })
})

const sentLists = () =>
  relay.frames.filter(({ from, text }) => from === 'mac' && text.startsWith('{"t":"phones",'))

async function removeAll(): Promise<void> {
  for (const phone of (await client.pairedPhones()).phones) await client.removePhone(phone.id)
}

test('a list the relay stored without its answer reaching the Mac is sent again exactly, then the newest, with no reset', async () => {
  await start()
  const first = await approvedPhone('First Phone')
  await approvedPhone('Second Phone')
  relay.lostAnswers.add('phones')
  const before = sentLists().length
  await removeAll()
  await expect.poll(() => relay.list(first.link.channel)?.rev).toBe(3)
  const lost = sentLists()[before]?.text
  relay.lostAnswers.delete('phones')
  relay.dropMac()

  await expect.poll(() => relay.list(first.link.channel)).toEqual({ rev: 4, keys: [] })
  const after = sentLists().slice(before + 1)
  expect(after[0]?.text).toBe(lost)
  expect(await client.pairedPhones()).toMatchObject({ pairAgain: false })
})

test('after a restart the unanswered list is sent again first', async () => {
  await start()
  const phone = await approvedPhone('Only Phone')
  relay.lostAnswers.add('phones')
  const before = sentLists().length
  await removeAll()
  await expect.poll(() => relay.list(phone.link.channel)?.rev).toBe(2)
  const lost = sentLists()[before]?.text
  expect(lost).toContain(`"base":"${relayListHash(1, [phone.relayKey()])}"`)
  await daemon?.stop()
  relay.lostAnswers.delete('phones')

  const restarted = sentLists().length
  await start()
  await expect.poll(() => sentLists().length).toBeGreaterThan(restarted)
  expect(sentLists()[restarted]?.text).toBe(lost)
  expect(await client.pairedPhones()).toMatchObject({ pairAgain: false, phones: [] })
})

test('a list with no answer in time drops the socket and reconnects, with no reset', async () => {
  await start({ relayListAckMs: 300 })
  const phone = await approvedPhone('Only Phone')
  const logins = macLogins()
  relay.unanswered.add('phones')
  await removeAll()
  await expect.poll(macLogins).toBeGreaterThan(logins)
  relay.unanswered.delete('phones')
  await expect.poll(() => relay.list(phone.link.channel)).toEqual({ rev: 2, keys: [] })
  expect(await client.pairedPhones()).toMatchObject({ pairAgain: false })
})

const macLogins = () =>
  relay.logins.filter(({ mode, status }) => mode === 'mac' && status === 200).length

const forwardedToMac = () =>
  relay.frames.filter(({ from, text }) => from === 'relay' && text.startsWith('{"t":"msg","conn"'))
    .length

test('an acknowledgement the store fails to record leaves phone messages unforwarded and is retried', async () => {
  await start()
  const kept = await approvedPhone('Kept Phone')
  await approvedPhone('Removed Phone')
  failAcks = true
  const logins = macLogins()
  const [, removed] = (await client.pairedPhones()).phones
  if (!removed) throw new Error('phone not listed')
  await client.removePhone(removed.id)
  await expect.poll(macLogins).toBeGreaterThan(logins + 1)

  const early = kept.message({ type: 'request', route: 'status' })
  const forwarded = forwardedToMac()
  await kept.sendRaw(early.envelope)
  await expect.poll(forwardedToMac).toBeGreaterThan(forwarded)
  failAcks = false
  await expect.poll(() => phoneStore?.relayAcked()?.rev).toBe(3)
  expect(await kept.status()).toMatchObject({ ok: true })
  expect(kept.replies.some((reply) => reply.id === early.id)).toBe(false)
  expect(await client.pairedPhones()).toMatchObject({ pairAgain: false })
})

test('a missed acknowledgement deadline reconnects even when the old socket never closes', async () => {
  await start({ relayListAckMs: 300 })
  const phone = await approvedPhone('Only Phone')
  const logins = macLogins()
  relay.freezeMac()
  await removeAll()
  await expect.poll(macLogins).toBeGreaterThan(logins)
  await expect.poll(() => relay.list(phone.link.channel)).toEqual({ rev: 2, keys: [] })
  expect(await client.pairedPhones()).toMatchObject({ pairAgain: false })
})
