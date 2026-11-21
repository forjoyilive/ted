import path from 'node:path'
import { devRelayUrl } from '@ted/protocol'
import { expect, test } from 'vitest'
import { loadPhoneKeys, phoneKeyringsForHome, replaceRelayKey } from '../src/phones/keys.ts'

const taskHome = path.resolve('task', 'node_modules', '.cache', 'ted-home')
const hidden = { TED_ELECTRON_HIDDEN: '1' }

test('hidden Ted Dev keeps pairing keys for one Task daemon and can rotate the relay key', async () => {
  const keyrings = phoneKeyringsForHome(taskHome, devRelayUrl, hidden, 'dev')
  const keys = await loadPhoneKeys(keyrings)
  expect(await loadPhoneKeys(keyrings)).toEqual(keys)

  const rotated = await replaceRelayKey(keyrings, keys)
  expect(rotated.box).toEqual(keys.box)
  expect(rotated.channel).not.toBe(keys.channel)
  expect(await loadPhoneKeys(keyrings)).toEqual(rotated)

  const nextDaemon = phoneKeyringsForHome(taskHome, devRelayUrl, hidden, 'dev')
  const freshKeys = await loadPhoneKeys(nextDaemon)
  expect(freshKeys.box.publicKey).not.toEqual(keys.box.publicKey)
  expect(freshKeys.channel).not.toBe(rotated.channel)
})

test('release, visible launches, other homes and remote relays use the OS keyring', () => {
  const normal = phoneKeyringsForHome(taskHome, devRelayUrl, {}, 'dev')
  expect(phoneKeyringsForHome(taskHome, devRelayUrl, hidden, 'release')).toBe(normal)
  expect(phoneKeyringsForHome(path.resolve('.ted-dev'), devRelayUrl, hidden, 'dev')).toBe(normal)
  expect(phoneKeyringsForHome(taskHome, 'https://relay.example.org', hidden, 'dev')).toBe(normal)
  expect(phoneKeyringsForHome(taskHome, devRelayUrl, hidden, 'dev')).not.toBe(normal)
})
