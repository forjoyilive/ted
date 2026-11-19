import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, expectTypeOf, test } from 'vitest'
import type { StoreContext } from '../src/store/context.ts'
import { checkStore, stateFile } from '../src/store/files.ts'
import { openStore } from '../src/store/open.ts'
import { trimChangesets } from '../src/store/trim-changesets.ts'

expectTypeOf<StoreContext>().toHaveProperty('store')

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-trim-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function changesetRows(): Promise<number> {
  const file = await stateFile(dir)
  if (!file) throw new Error('no state database')
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return (
      db.prepare('SELECT COUNT(*) AS n FROM __livestore_session_changeset').get() as { n: number }
    ).n
  } finally {
    db.close()
  }
}

test('emptying the changeset table keeps the state, needs no rebuild and lets new events commit', async () => {
  let store = await openStore({ directory: dir })
  const description = 'x'.repeat(2000)
  for (let i = 0; i < 40; i++) await store.createTask({ title: `Task ${i}`, description })
  const before = store.listTasks()
  await store.close()
  const rows = await changesetRows()
  expect(rows).toBeGreaterThanOrEqual(40)

  expect(await trimChangesets(dir, { atLeastBytes: 1024 * 1024 * 1024 })).toMatchObject({
    kind: 'nothing',
  })
  expect(await changesetRows()).toBe(rows)

  const file = (await stateFile(dir)) as string
  const bytes = (await stat(file)).size
  const trim = await trimChangesets(dir, { atLeastBytes: 1 })
  expect(trim).toMatchObject({ kind: 'trimmed', rows, bytesBefore: bytes })
  expect(trim.kind === 'trimmed' && trim.bytesAfter).toBeLessThan(bytes)
  expect(await changesetRows()).toBe(0)
  expect(await checkStore(dir)).toEqual({ kind: 'current' })

  store = await openStore({ directory: dir })
  expect(store.listTasks()).toEqual(before)
  const added = await store.createTask({ title: 'After the trim' })
  await store.close()

  store = await openStore({ directory: dir })
  try {
    const after = store.listTasks()
    expect(after.filter((task) => task.id !== added.id)).toEqual(before)
    expect(after.find((task) => task.id === added.id)).toMatchObject({ title: 'After the trim' })
  } finally {
    await store.close()
  }
})

test('a state database that can’t be read is reported, not thrown', async () => {
  const store = await openStore({ directory: dir })
  await store.close()
  const db = new DatabaseSync((await stateFile(dir)) as string)
  db.exec('DROP TABLE __livestore_session_changeset')
  db.close()
  expect(await trimChangesets(dir, { atLeastBytes: 0 })).toMatchObject({ kind: 'failed' })
})
