import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { openStore } from '../src/store/index.ts'
import { events } from '../src/store/schema.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-store-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('TedStore', () => {
  test('creates Tasks with a stable ID and numbered display IDs', async () => {
    const store = await openStore({ directory: dir })
    try {
      const first = await store.createTask({ title: 'Fix login' })
      const second = await store.createTask({ title: 'Add dark mode' })

      expect(first.displayId).toBe('DEV-1')
      expect(second.displayId).toBe('DEV-2')
      expect(first.id).not.toBe(second.id)
      expect(store.listTasks().map((t) => [t.displayId, t.title])).toEqual([
        ['DEV-1', 'Fix login'],
        ['DEV-2', 'Add dark mode'],
      ])
    } finally {
      await store.close()
    }
  })

  test('keeps Tasks after the store is closed and reopened', async () => {
    const first = await openStore({ directory: dir })
    const created = await first.createTask({ title: 'Fix login' })
    await first.close()

    const second = await openStore({ directory: dir })
    try {
      expect(second.listTasks()).toEqual([created])
      expect((await second.createTask({ title: 'Next' })).displayId).toBe('DEV-2')
    } finally {
      await second.close()
    }
  })

  test('rebuilds state from the event log', async () => {
    const first = await openStore({ directory: dir })
    const a = await first.createTask({ title: 'Fix login' })
    const b = await first.createTask({ title: 'Add dark mode' })
    await first.close()

    const storeFiles = await readdir(path.join(dir, 'ted'))
    const stateFiles = storeFiles.filter((f) => f.startsWith('state'))
    expect(stateFiles).not.toHaveLength(0)
    for (const f of stateFiles) await rm(path.join(dir, 'ted', f))

    const second = await openStore({ directory: dir })
    try {
      expect(second.listTasks()).toEqual([a, b])
    } finally {
      await second.close()
    }
  })

  test('every event has a versioned name', () => {
    for (const event of Object.values(events)) {
      expect(event.name).toMatch(/^v[1-9][0-9]*\.[A-Z][A-Za-z]+$/)
    }
  })
})
