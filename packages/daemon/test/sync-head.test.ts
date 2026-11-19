import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, expectTypeOf, test } from 'vitest'
import type { StoreContext } from '../src/store/context.ts'
import { eventlogFile, stateFile } from '../src/store/files.ts'
import { openStore } from '../src/store/open.ts'
import { markEventsSynced } from '../src/store/sync-head.ts'

expectTypeOf<StoreContext>().toHaveProperty('store')

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-sync-head-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function inEventlog<T>(work: (db: DatabaseSync) => T): Promise<T> {
  const db = new DatabaseSync((await eventlogFile(dir)) as string)
  try {
    return work(db)
  } finally {
    db.close()
  }
}

const heads = () =>
  inEventlog(
    (db) =>
      db
        .prepare(
          'SELECT head, (SELECT MAX(seqNumGlobal) FROM eventlog) AS newest FROM __livestore_sync_status',
        )
        .get() as { head: number; newest: number },
  )

test('each open marks every event as synced, and the store still commits, reopens and rebuilds', async () => {
  expect(await markEventsSynced(dir)).toEqual({ kind: 'nothing' })

  let store = await openStore({ directory: dir })
  for (let i = 0; i < 5; i++) await store.createTask({ title: `Task ${i}` })
  const before = store.listTasks()
  await store.close()
  const first = await heads()
  expect(first.head).toBeLessThan(first.newest)

  store = await openStore({ directory: dir })
  expect((await heads()).head).toBe(first.newest)
  expect(store.listTasks()).toEqual(before)
  const added = await store.createTask({ title: 'After the head moved' })
  await store.close()

  expect(await markEventsSynced(dir)).toMatchObject({ kind: 'marked', from: first.newest })
  expect(await markEventsSynced(dir)).toEqual({ kind: 'nothing' })

  await rm((await stateFile(dir)) as string)
  store = await openStore({ directory: dir })
  try {
    const rebuilt = store.listTasks()
    expect(rebuilt.filter((task) => task.id !== added.id)).toEqual(before)
    expect(rebuilt.find((task) => task.id === added.id)).toMatchObject({
      title: 'After the head moved',
    })
  } finally {
    await store.close()
  }
})

test('a head above the newest event, as after events were dropped, is lowered before the store opens', async () => {
  let store = await openStore({ directory: dir })
  await store.createTask({ title: 'Kept' })
  await store.close()
  const { newest } = await heads()
  await inEventlog((db) =>
    db.prepare('UPDATE __livestore_sync_status SET head = ?').run(newest + 50),
  )

  store = await openStore({ directory: dir })
  try {
    expect((await heads()).head).toBe(newest)
    expect(store.listTasks()).toMatchObject([{ title: 'Kept' }])
  } finally {
    await store.close()
  }
})
