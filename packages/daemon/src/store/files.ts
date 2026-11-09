import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { events, schema } from './schema.ts'

export const storeId = 'ted'
export const storeFolder = storeId
const metaFile = 'ted-store.json'
const eventlogPattern = /^eventlog@(\d+)\.db$/
const statePrefix = `state${schema.state.sqlite.hash}@`

export interface StoreMeta {
  lastOpenedBy: string
  lastOpenedAt: string
}

export type StoreCheck =
  | { kind: 'empty' }
  | { kind: 'current' }
  | { kind: 'rebuild'; events: number }
  | { kind: 'newer'; unknownEvents: string[] }

const knownEvents = new Set<string>(Object.values(events).map((event) => event.name))

async function filesIn(directory: string): Promise<string[]> {
  return readdir(path.join(directory, storeFolder)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
}

export async function eventlogFile(directory: string): Promise<string | undefined> {
  const newest = (await filesIn(directory))
    .map((file) => ({ file, format: Number(eventlogPattern.exec(file)?.[1] ?? Number.NaN) }))
    .filter(({ format }) => !Number.isNaN(format))
    .sort((a, b) => b.format - a.format)[0]
  return newest && path.join(directory, storeFolder, newest.file)
}

function readOnly<T>(file: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return read(db)
  } finally {
    db.close()
  }
}

function stateIsComplete(file: string): boolean {
  try {
    return readOnly(
      file,
      (db) => db.prepare('SELECT id FROM __livestore_rebuild WHERE id = 1').get() !== undefined,
    )
  } catch {
    return false
  }
}

// A journal left by a killed writer makes every read-only open fail with
// “attempt to write a readonly database”; a read-write open rolls it back first.
async function rollBackInterruptedWrites(directory: string): Promise<void> {
  const files = await filesIn(directory)
  for (const file of files) {
    if (!file.endsWith('.db') || !files.includes(`${file}-journal`)) continue
    const db = new DatabaseSync(path.join(directory, storeFolder, file))
    try {
      db.prepare('SELECT COUNT(*) FROM sqlite_master').get()
    } finally {
      db.close()
    }
  }
}

export async function checkStore(directory: string): Promise<StoreCheck> {
  await rollBackInterruptedWrites(directory)
  const eventlog = await eventlogFile(directory)
  if (!eventlog) return { kind: 'empty' }
  const { names, count } = readOnly(eventlog, (db) => ({
    names: db.prepare('SELECT DISTINCT name FROM eventlog').all() as { name: string }[],
    count: (db.prepare('SELECT COUNT(*) AS count FROM eventlog').get() as { count: number }).count,
  }))
  const unknownEvents = names.map((row) => row.name).filter((name) => !knownEvents.has(name))
  if (unknownEvents.length > 0) return { kind: 'newer', unknownEvents }
  const state = (await filesIn(directory)).find(
    (file) => file.startsWith(statePrefix) && file.endsWith('.db'),
  )
  if (count > 0 && (!state || !stateIsComplete(path.join(directory, storeFolder, state)))) {
    return { kind: 'rebuild', events: count }
  }
  return { kind: 'current' }
}

export async function eventCount(directory: string): Promise<number> {
  const eventlog = await eventlogFile(directory)
  if (!eventlog) return 0
  return readOnly(
    eventlog,
    (db) => (db.prepare('SELECT COUNT(*) AS count FROM eventlog').get() as { count: number }).count,
  )
}

export async function removeStaleStateFiles(directory: string): Promise<void> {
  for (const file of await filesIn(directory)) {
    if (file.startsWith('state') && !file.startsWith(statePrefix)) {
      await rm(path.join(directory, storeFolder, file), { force: true })
    }
  }
}

export async function readStoreMeta(directory: string): Promise<StoreMeta | undefined> {
  try {
    const meta = JSON.parse(await readFile(path.join(directory, metaFile), 'utf8')) as StoreMeta
    return typeof meta.lastOpenedBy === 'string' ? meta : undefined
  } catch {
    return undefined
  }
}

export async function writeStoreMeta(directory: string, meta: StoreMeta): Promise<void> {
  const file = path.join(directory, metaFile)
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(meta, null, 2), { mode: 0o600 })
  await rename(tmp, file)
}
