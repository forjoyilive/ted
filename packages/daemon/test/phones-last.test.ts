import { type DaemonClient, type MacReply, readDaemonInfo } from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/daemon.ts'
import { appClient, killRunHosts, makeTempHome, stubClaudePath } from './helpers.ts'
import { memoryKeyrings, type RelayStub, startRelayStub, TestPhone } from './support/phone-relay.ts'

let home: string
let cleanup: () => Promise<void>
let relay: RelayStub
let daemon: RunningDaemon
let client: DaemonClient
const phones: TestPhone[] = []

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  relay = await startRelayStub()
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    phones: {
      keyrings: memoryKeyrings().keyrings,
      relayUrl: relay.url,
      macName: async () => 'Studio Mac',
      relayDelaysMs: [50],
    },
  })
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('No daemon.json')
  client = appClient(info, daemon.appToken)
})

afterEach(async () => {
  for (const phone of phones.splice(0)) phone.close()
  await daemon?.stop()
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

function failure(reply: MacReply): string | undefined {
  return reply.ok ? undefined : reply.error.code
}

test('removing the only paired phone still answers it with not-paired', async () => {
  const phone = await newPhone()
  await phone.pair('Only Phone')
  await client.approvePhonePairing({ pairing: phone.link.pairing })
  expect(await phone.status()).toMatchObject({ ok: true })

  const [only] = (await client.pairedPhones()).phones
  if (!only) throw new Error('phone not listed')
  await client.removePhone(only.id)
  expect((await client.pairedPhones()).phones).toEqual([])
  expect(failure(await phone.status())).toBe('not-paired')
  expect(failure(await phone.status())).toBe('not-paired')
})

test('a phone refused while no other phone is paired still hears it was refused', async () => {
  const phone = await newPhone()
  await phone.pair('Refused Phone')
  await client.refusePhonePairing({ pairing: phone.link.pairing })
  expect(await phone.send({ type: 'pair-status', pairing: phone.link.pairing })).toMatchObject({
    ok: true,
    body: { state: 'refused' },
  })
})
