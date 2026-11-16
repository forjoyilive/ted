import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { readStubKeyring, stubKeyring, type WriteTemporary } from './fixtures/stub-keyring.ts'

function pausedWrite(pause: () => Promise<void>): WriteTemporary {
  return async (file, text) => {
    const handle = await open(file, 'wx', 0o600)
    try {
      await pause()
      await handle.writeFile(text)
    } finally {
      await handle.close()
    }
  }
}

test.each(['set', 'delete'] as const)(
  'readers see complete keyring state while %s is still writing',
  async (operation) => {
    const home = await mkdtemp(path.join(tmpdir(), 'ted-keyring-'))
    const file = path.join(home, 'keyring.json')
    const previous = { state: 'ok', secret: 'previous' }
    await writeFile(file, JSON.stringify(previous))
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const startedWriting = new Promise<void>((resolve) => {
      started = resolve
    })
    const keyring = stubKeyring(
      file,
      pausedWrite(() => {
        started()
        return held
      }),
    )
    const saving = operation === 'set' ? keyring.set('new') : keyring.delete()
    try {
      await startedWriting
      expect(await readStubKeyring(file)).toEqual(previous)
      release()
      await saving
      expect(await readStubKeyring(file)).toEqual(
        operation === 'set' ? { state: 'ok', secret: 'new' } : { state: 'ok' },
      )
    } finally {
      release()
      await saving
      await rm(home, { recursive: true, force: true })
    }
  },
)
