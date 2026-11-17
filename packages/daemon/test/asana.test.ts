import { readFile, rename } from 'node:fs/promises'
import path from 'node:path'
import {
  asanaScopes,
  type DaemonClient,
  parseAsanaConfiguration,
  readDaemonInfo,
} from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/daemon.ts'
import { type Keyring, KeyringUnavailableError } from '../src/linear/keyring.ts'
import { startStubAsana, unusedPort } from './fixtures/stub-asana.ts'
import { appClient, makeTempHome, waitUntil } from './helpers.ts'

const writes = { failCommit: false }
const commitFile = async (temporary: string, file: string) => {
  if (writes.failCommit && file.endsWith('/asana-credentials/oauth.json'))
    throw new Error('simulated file commit failure')
  await rename(temporary, file)
}

const configuration = { clientId: '12345', clientSecret: 'client-secret-opaque', inFile: false }
let home: string
let cleanup: () => Promise<void>
let stub: Awaited<ReturnType<typeof startStubAsana>>
let daemon: RunningDaemon | undefined
let callbackPort: number
let clock: number
let secret: string | undefined
let keyringProblem: 'locked' | 'no-keyring' | undefined
const keyring: Keyring = {
  kind: 'macos-keychain',
  async get() {
    if (keyringProblem)
      throw new KeyringUnavailableError(keyringProblem, configuration.clientSecret)
    return secret
  },
  async set(value) {
    if (keyringProblem)
      throw new KeyringUnavailableError(keyringProblem, configuration.clientSecret)
    secret = value
  },
  async delete() {
    if (keyringProblem)
      throw new KeyringUnavailableError(keyringProblem, configuration.clientSecret)
    secret = undefined
  },
}
beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  stub = await startStubAsana()
  callbackPort = await unusedPort()
  clock = Date.now()
  secret = undefined
  keyringProblem = undefined
  writes.failCommit = false
})
afterEach(async () => {
  writes.failCommit = false
  await daemon?.stop()
  daemon = undefined
  await stub.close()
  await cleanup()
})
async function start() {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    asana: {
      keyring,
      oauthOrigin: stub.url,
      apiOrigin: stub.url,
      callbackPort,
      now: () => clock,
      commitFile,
    },
  })
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('No daemon info')
  return appClient(info, daemon.appToken)
}
async function authorize(client: DaemonClient) {
  const { url } = await client.connectAsana()
  expect(new URL(url).searchParams.get('code_challenge_method')).toBe('S256')
  expect(url).not.toContain(configuration.clientSecret)
  expect((await fetch(stub.callback(url))).status).toBe(200)
  await waitUntil(async () => (await client.getAsana()).state === 'connected', 'connected account')
  return url
}

test('configuration parser copies every field and rejects malformed input without quoting it', () => {
  expect(parseAsanaConfiguration({ ...configuration, inFile: true, ignored: 'extra' })).toEqual({
    ...configuration,
    inFile: true,
  })
  expect(parseAsanaConfiguration({ clientId: '123', clientSecret: 'secret' })).toEqual({
    clientId: '123',
    clientSecret: 'secret',
    inFile: false,
  })
  for (const value of [
    null,
    [],
    'secret',
    {},
    { ...configuration, clientId: '../' },
    { ...configuration, clientSecret: '' },
    { ...configuration, inFile: 'yes' },
  ])
    expect(() => parseAsanaConfiguration(value)).toThrow()
})

test('authorize, restart, serialize expired-token refresh, handle revocation and disconnect offline', async () => {
  let client = await start()
  expect(await client.getAsana()).toMatchObject({ state: 'unconfigured' })
  expect(await client.configureAsana(configuration)).toMatchObject({
    state: 'disconnected',
    storedIn: 'keyring',
  })
  await authorize(client)
  expect(await client.getAsana()).toMatchObject({
    state: 'connected',
    user: { gid: '100', name: 'Avery' },
  })
  await daemon?.stop()
  daemon = undefined
  client = await start()
  expect(await client.getAsana()).toMatchObject({ state: 'connected' })
  clock += 3_600_000
  const before = stub.requests.filter((r) => r.fields.grant_type === 'refresh_token').length
  expect(await Promise.all([client.testAsana(), client.testAsana(), client.testAsana()])).toEqual(
    expect.arrayContaining([expect.objectContaining({ state: 'connected' })]),
  )
  expect(stub.requests.filter((r) => r.fields.grant_type === 'refresh_token')).toHaveLength(
    before + 1,
  )
  stub.setRefreshToken('rotated-refresh-secret')
  clock += 3_600_000
  expect(await client.testAsana()).toMatchObject({ state: 'connected' })
  expect(secret).toContain('rotated-refresh-secret')
  stub.setRefreshToken(undefined)
  clock += 3_600_000
  expect(await client.testAsana()).toMatchObject({ state: 'connected' })
  expect(
    stub.requests.filter((r) => r.fields.grant_type === 'refresh_token').at(-1)?.fields
      .refresh_token,
  ).toBe('rotated-refresh-secret')
  expect(secret).toContain('rotated-refresh-secret')
  stub.setRefreshToken('refresh-secret-opaque')
  stub.setRevoked(true)
  expect(await client.testAsana()).toMatchObject({ state: 'error', configured: true })
  expect(await client.getAsana()).not.toHaveProperty('user')
  stub.setRevoked(false)
  await authorize(client)
  stub.setOffline(true)
  expect(await client.disconnectAsana()).toMatchObject({
    configured: true,
    error: expect.stringContaining('Disconnected locally'),
  })
  expect(secret).not.toContain('access-secret-opaque')
  expect(secret).not.toContain('refresh-secret-opaque')
  expect(await client.removeAsana()).toMatchObject({ state: 'unconfigured' })
  expect(secret).toBeUndefined()
})

test('replacement clears the old user, cancel stays disconnected and a different identity needs new authorization', async () => {
  const client = await start()
  await client.configureAsana(configuration)
  await authorize(client)
  const pending = await client.connectAsana()
  expect(await client.getAsana()).not.toHaveProperty('user')
  await client.cancelAsana()
  await expect(fetch(stub.callback(pending.url))).rejects.toThrow()
  expect(secret).not.toContain('refresh-secret-opaque')
  stub.setUser({ gid: '200', name: 'Sam', email: 'sam@example.test' })
  await authorize(client)
  expect(await client.getAsana()).toMatchObject({ user: { gid: '200' } })
  stub.setUser({ gid: '300', name: 'Unexpected', email: 'other@example.test' })
  expect(await client.testAsana()).toMatchObject({
    state: 'error',
    error: expect.stringContaining('different account'),
  })
  expect(await client.getAsana()).not.toHaveProperty('user')
})

test('locked storage never silently falls back; unavailable keyrings permit an explicit protected file', async () => {
  const client = await start()
  keyringProblem = 'locked'
  expect(await client.getAsana()).toMatchObject({ storageProblem: 'locked' })
  await expect(client.configureAsana({ ...configuration, inFile: true })).rejects.toThrow()
  keyringProblem = 'no-keyring'
  await expect(client.configureAsana(configuration)).rejects.toThrow()
  expect(await client.configureAsana({ ...configuration, inFile: true })).toMatchObject({
    storedIn: 'file',
  })
  await authorize(client)
  await daemon?.stop()
  daemon = undefined
  const restored = await start()
  expect(await restored.getAsana()).toMatchObject({ state: 'connected', storedIn: 'file' })
  await restored.disconnectAsana()
  expect(await readFile(path.join(home, 'asana-credentials/oauth.json'), 'utf8')).not.toContain(
    'refresh-secret-opaque',
  )
  await restored.removeAsana()
})

test('fallback removal never revives an inactive keyring account, even across outages and restart', async () => {
  let client = await start()
  await client.configureAsana(configuration)
  await authorize(client)
  const original = secret
  keyringProblem = 'no-keyring'
  await client.configureAsana({ clientId: '456', clientSecret: 'replacement-secret', inFile: true })
  expect(secret).toBe(original)
  keyringProblem = undefined
  expect(await client.removeAsana()).toMatchObject({ state: 'unconfigured', configured: false })
  expect(secret).toBeUndefined()
  await client.configureAsana(configuration)
  await authorize(client)
  keyringProblem = 'no-keyring'
  await client.configureAsana({ clientId: '456', clientSecret: 'replacement-secret', inFile: true })
  expect(await client.removeAsana()).toMatchObject({
    state: 'error',
    configured: false,
    error: expect.stringContaining('could not be deleted'),
  })
  const marker = await readFile(path.join(home, 'asana-credentials/oauth.json'), 'utf8')
  expect(marker).not.toContain('replacement-secret')
  expect(marker).not.toContain('client-secret-opaque')
  await daemon?.stop()
  daemon = undefined
  client = await start()
  expect(await client.getAsana()).toMatchObject({ state: 'error', configured: false })
  expect(await client.getAsana()).not.toHaveProperty('user')
  keyringProblem = undefined
  expect(await client.getAsana()).toMatchObject({ state: 'unconfigured' })
  expect(secret).toBeUndefined()
})

test('failed fallback commit preserves the previous keyring connection and credentials', async () => {
  const client = await start()
  await client.configureAsana(configuration)
  await authorize(client)
  const original = secret
  writes.failCommit = true
  try {
    await expect(
      client.configureAsana({ clientId: '456', clientSecret: 'replacement-secret', inFile: true }),
    ).rejects.toThrow()
  } finally {
    writes.failCommit = false
  }
  expect(secret).toBe(original)
  expect(await client.getAsana()).toMatchObject({ state: 'connected', user: { gid: '100' } })
  await expect(readFile(path.join(home, 'asana-credentials/oauth.json'), 'utf8')).rejects.toThrow()
})

test('authorization and refresh fail closed for missing, incomplete, inactive and wrong-client grants', async () => {
  const client = await start()
  await client.configureAsana(configuration)
  for (const [grant, problem] of [
    [{ scope: undefined }, 'Asana sent no scope list'],
    [{ scope: 'users:read' }, 'these scopes are missing: attachments:read, projects:read,'],
    [{ active: false }, 'the token isn’t active'],
    [{ client_id: 'another-app' }, 'the token belongs to client ID another-app, not 12345'],
    [{ client_id: 54321 }, 'the token belongs to client ID 54321, not 12345'],
  ] as const) {
    stub.setGrant(grant)
    const { url } = await client.connectAsana()
    expect((await fetch(stub.callback(url))).status).toBe(200)
    const status = await client.getAsana()
    expect(status).toMatchObject({
      state: 'error',
      error: expect.stringContaining(problem),
    })
    expect(status.error).toContain('permission grant')
    expect(status).not.toHaveProperty('user')
    expect(secret).not.toContain('access-secret-opaque')
  }
  stub.setGrant(undefined)
  stub.setTokenError(401)
  const rejected = await client.connectAsana()
  expect((await fetch(stub.callback(rejected.url))).status).toBe(200)
  expect(await client.getAsana()).toMatchObject({
    state: 'error',
    error: expect.stringContaining('didn’t accept this app’s client ID and secret'),
  })
  stub.setTokenError(false)
  for (const sent of [12345, ' 12345 ']) {
    stub.setGrant({ client_id: sent })
    await authorize(client)
  }
  stub.setGrant({
    client_id: undefined,
    token_type: 'Bearer',
    scope: `${asanaScopes.join(' ')} projects:write openid email profile`,
  })
  await authorize(client)
  expect(await client.getAsana()).toMatchObject({
    state: 'connected',
    user: { gid: '100' },
    extraScopes: ['projects:write'],
  })
  expect(JSON.parse(secret ?? '{}').tokens.scopes).toHaveLength(12)
  const unverified = JSON.parse(secret ?? '{}')
  delete unverified.tokens.scopes
  secret = JSON.stringify(unverified)
  expect(await client.getAsana()).toMatchObject({
    state: 'error',
    error: expect.stringContaining('permission grant'),
  })
  expect(await client.getAsana()).not.toHaveProperty('user')
  expect(await client.testAsana()).toMatchObject({ state: 'connected' })
  clock += 3_600_000
  stub.setGrant({ scope: 'users:read' })
  expect(await client.testAsana()).toMatchObject({
    state: 'error',
    error: expect.stringContaining('permission grant'),
  })
  expect(await client.getAsana()).not.toHaveProperty('user')
  expect(secret).not.toContain('refresh-secret-opaque')
})
