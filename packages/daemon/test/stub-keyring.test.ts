import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test, vi } from 'vitest'
import { readStubKeyring, stubKeyring } from './fixtures/stub-keyring.ts'

const writing = vi.hoisted(() => ({ pause: undefined as (() => Promise<void>) | undefined }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      if (writing.pause) {
        const options = typeof args[2] === 'object' ? args[2] : undefined
        const file = await fs.open(String(args[0]), options?.flag ?? 'w', options?.mode)
        try {
          await writing.pause()
          await file.writeFile(args[1])
        } finally {
          await file.close()
        }
        return
      }
      return fs.writeFile(...args)
    },
  }
})

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
    writing.pause = () => {
      started()
      return held
    }
    const keyring = stubKeyring(file)
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
      writing.pause = undefined
      release()
      await saving
      await rm(home, { recursive: true, force: true })
    }
  },
)
