import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseSideChatMessageRequest } from '@ted/protocol'
import { expect, test } from 'vitest'
import {
  boundSnapshot,
  readSnapshot,
  snapshotLimit,
  writeSnapshot,
} from '../src/side-chats/context.ts'

test('bounds a Unicode snapshot while keeping its opening and latest context', () => {
  const snapshot = boundSnapshot(`Opening ${'x'.repeat(30_000)}`, `${'a'.repeat(210_000)}Latest 🌎`)
  expect(snapshot.truncated).toBe(true)
  expect(Buffer.byteLength(snapshot.text)).toBeLessThanOrEqual(snapshotLimit)
  expect(snapshot.text).toMatch(/^Opening /)
  expect(snapshot.text).toMatch(/Latest 🌎$/)
})
test('never follows a replaced snapshot symlink', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'ted-snapshot-'))
  const id = randomUUID()
  try {
    await writeSnapshot(home, id, 'Frozen context')
    expect(await readSnapshot(home, id)).toBe('Frozen context')
    const file = path.join(home, 'runs', id, 'side-chat-context.txt')
    const other = path.join(home, 'other.txt')
    await writeFile(other, 'Other data')
    await rm(file)
    await symlink(other, file)
    await expect(readSnapshot(home, id)).rejects.toThrow()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
test('validates side questions without accepting blank, missing or oversized text', () => {
  expect(parseSideChatMessageRequest({ text: ' Why? ' })).toEqual({ text: 'Why?' })
  for (const input of [null, [], {}, { text: 1 }, { text: '  ' }, { text: 'x'.repeat(10_001) }])
    expect(() => parseSideChatMessageRequest(input)).toThrow()
})
