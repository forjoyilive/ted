import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fromBase64Url, phoneProtocolVersion, readDaemonInfo, toBase64Url } from '@ted/protocol'
import nacl from 'tweetnacl'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/daemon.ts'
import { phoneBoxKeyAccount, phoneSignKeyAccount } from '../src/phones/keys.ts'
import {
  api,
  appClient,
  devRunToken,
  killRunHosts,
  makeTempHome,
  stubClaudePath,
  tokenFor,
} from './helpers.ts'
import {
  type MemoryKeyrings,
  memoryKeyrings,
  type RelayStub,
  startRelayStub,
  TestPhone,
} from './support/phone-relay.ts'

const macName = 'Security Test Mac'
let home: string
let cleanup: () => Promise<void>
let relay: RelayStub
let daemon: RunningDaemon | undefined
let keychain: MemoryKeyrings
const phones: TestPhone[] = []

beforeAll(async () => {
  ;({ home, cleanup } = await makeTempHome())
  relay = await startRelayStub()
  keychain = memoryKeyrings()
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    phones: {
      keyrings: keychain.keyrings,
      relayUrl: relay.url,
      macName: async () => macName,
      relayDelaysMs: [50],
    },
  })
})

afterAll(async () => {
  for (const phone of phones) phone.close()
  await daemon?.stop()
  await relay?.close()
  await killRunHosts(home)
  await cleanup()
})

const phoneRoutes = [
  ['POST', '/phones/pairings', undefined],
  ['GET', '/phones/pairings/current', undefined],
  ['DELETE', '/phones/pairings/current', undefined],
  ['POST', '/phones/pairings/current/approve', { pairing: 'AAAAAAAAAAAAAAAAAAAAAA' }],
  ['POST', '/phones/pairings/current/refuse', { pairing: 'AAAAAAAAAAAAAAAAAAAAAA' }],
  ['GET', '/phones', undefined],
  ['DELETE', '/phones/00000000-0000-0000-0000-000000000000', undefined],
] as const

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return walk(full)
      return entry.isFile() ? [full] : []
    }),
  )
  return files.flat()
}

function encodings(bytes: Uint8Array): Buffer[] {
  const buffer = Buffer.from(bytes)
  return [
    buffer,
    Buffer.from(buffer.toString('base64url')),
    Buffer.from(buffer.toString('base64')),
    Buffer.from(buffer.toString('hex')),
    Buffer.from(buffer.toString('hex').toUpperCase()),
  ]
}

test('the file token and a Run token get 403 on every phone route, GETs included', async () => {
  if (!daemon) throw new Error('no daemon')
  const fileApi = api(daemon.port, await tokenFor(home))
  const runApi = api(daemon.port, await devRunToken(home, daemon.port, daemon.appToken))
  for (const [method, route, body] of phoneRoutes) {
    for (const [who, caller] of [
      ['file token', fileApi],
      ['Run token', runApi],
    ] as const) {
      const res = await caller.call(method, route, body)
      expect(res.status, `${who} ${method} ${route}`).toBe(403)
    }
  }
  expect((await api(daemon.port, { appKey: daemon.appToken }).call('GET', '/phones')).status).toBe(
    200,
  )
})

test('no HTTP path reaches the phone status route', async () => {
  if (!daemon) throw new Error('no daemon')
  const app = api(daemon.port, { appKey: daemon.appToken })
  for (const method of ['GET', 'POST']) {
    for (const route of [
      '/status',
      '/phones/status',
      '/phone/status',
      '/phones/request',
      '/phone',
    ]) {
      const res = await app.call(method, route, method === 'POST' ? { route: 'status' } : undefined)
      expect(res.status, `${method} ${route}`).toBe(404)
      expect(JSON.stringify(res.body)).not.toContain(macName)
    }
  }
})

test('nothing in TED_HOME holds the Mac’s keys or the secret, or lets a phone be impersonated', async () => {
  if (!daemon) throw new Error('no daemon')
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('No daemon.json')
  const client = appClient(info, daemon.appToken)
  const offer = await client.createPhonePairing()
  const phone = new TestPhone(offer.link)
  phones.push(phone)
  await phone.pair('Real Phone')
  await client.approvePhonePairing({ pairing: phone.link.pairing })
  await phone.approved()
  expect(await phone.status()).toMatchObject({ ok: true, body: { mac: macName } })

  const boxSecret = fromBase64Url(keychain.secrets.get(phoneBoxKeyAccount) ?? '', 32)
  const signSeed = fromBase64Url(keychain.secrets.get(phoneSignKeyAccount) ?? '', 32)
  const pairingSecret = fromBase64Url(phone.link.secret, 32)
  if (!boxSecret || !signSeed || !pairingSecret) throw new Error('keys not in the Keychain stub')
  const signSecret = nacl.sign.keyPair.fromSeed(signSeed).secretKey
  const needles = [boxSecret, signSeed, signSecret, pairingSecret].flatMap(encodings)

  const attacker = nacl.box.keyPair()
  const forgedId = toBase64Url(nacl.randomBytes(16))
  const forged = phone.seal(
    {
      protocol: phoneProtocolVersion,
      id: forgedId,
      at: Date.now(),
      type: 'request',
      route: 'status',
    },
    attacker,
  )
  const asPhone = JSON.stringify({ ...JSON.parse(forged), from: phone.publicKey() })
  const outsider = new TestPhone(offer.link, { keys: attacker })
  await phone.sendRaw(asPhone)
  const refused = await outsider.send(
    { type: 'request', route: 'status' },
    phoneProtocolVersion,
    phone,
  )
  expect(refused).toMatchObject({ ok: false, error: { code: 'not-paired' } })
  expect(phone.replies.some((reply) => reply.id === forgedId)).toBe(false)

  await daemon.stop()
  daemon = undefined
  const files = await walk(home)
  expect(files.length).toBeGreaterThan(0)
  let sawPhoneKey = false
  for (const file of files) {
    const content = await readFile(file)
    for (const needle of needles) expect(content.includes(needle), file).toBe(false)
    if (content.includes(Buffer.from(phone.publicKey()))) sawPhoneKey = true
  }
  expect(sawPhoneKey).toBe(true)
})
