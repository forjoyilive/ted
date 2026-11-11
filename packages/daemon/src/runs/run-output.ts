import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import path from 'node:path'
import { type ConversationEntry, tedPaths } from '@ted/protocol'
import type { TedStore } from '../store/index.ts'
import { type HostRecord, runFiles } from './host-files.ts'

export type OutputKept = 'all' | 'tail' | 'none'

export interface OutputFold {
  add(entry: ConversationEntry): void
}

export interface RunOutputReader {
  kept(runId: string): OutputKept
  stamp(runId: string): string
  entries(runId: string): ConversationEntry[]
  fold<T extends OutputFold>(runId: string, name: string, create: () => T): T
  last(runId: string, count: number): ConversationEntry[]
  findLast(
    runId: string,
    matches: (entry: ConversationEntry) => boolean,
  ): ConversationEntry | undefined
}

export interface RunOutputOptions {
  home: string
  store: Pick<TedStore, 'getRun' | 'runReadOffset'>
  cacheBytes?: number
  cacheRuns?: number
}

const defaultCacheBytes = 64 * 1024 * 1024
const defaultCacheRuns = 64
const chunkBytes = 1024 * 1024

type Source = 'log' | 'tail'

interface OpenLog {
  fd: number
  size: number
  inode: number
  to: number
}

interface Cached {
  source: Source
  inode: number
  parsedTo: number
  entries: ConversationEntry[]
  bytes: number
  folds: Map<string, { fold: OutputFold; count: number }>
}

const weight = (cached: Cached) => cached.bytes * (cached.folds.size > 0 ? 2 : 1)

export function createRunOutput(options: RunOutputOptions): RunOutputReader {
  const { store } = options
  const runsDir = tedPaths(options.home).runs
  const cacheBytes = options.cacheBytes ?? defaultCacheBytes
  const cacheRuns = options.cacheRuns ?? defaultCacheRuns
  const cache = new Map<string, Cached>()

  function logOf(runId: string): string | undefined {
    const dir = path.join(runsDir, runId)
    return path.dirname(dir) === runsDir && path.basename(dir) === runId
      ? runFiles(dir).log
      : undefined
  }

  function keep(runId: string, cached: Cached): Cached {
    cache.delete(runId)
    cache.set(runId, cached)
    let total = 0
    for (const held of cache.values()) total += weight(held)
    for (const [id, held] of cache) {
      if (cache.size <= 1 || (total <= cacheBytes && cache.size <= cacheRuns)) break
      cache.delete(id)
      total -= weight(held)
    }
    return cached
  }

  function openLog(runId: string): OpenLog | undefined {
    const run = store.getRun(runId)
    const file = run && logOf(run.id)
    if (!run || file === undefined) return undefined
    let fd: number
    try {
      fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    } catch {
      return undefined
    }
    try {
      const { size, ino } = fstatSync(fd)
      return { fd, size, inode: ino, to: store.runReadOffset(run.id) }
    } catch {
      closeSync(fd)
      return undefined
    }
  }

  function fromFile(runId: string, { fd, size, inode, to }: OpenLog): Cached {
    const cached = cache.get(runId)
    if (size < to) {
      if (cached?.source === 'tail' && cached.inode === inode) return keep(runId, cached)
      const entries = readEntries(fd, 0, size, to - size)
      return keep(runId, {
        source: 'tail',
        inode,
        parsedTo: size,
        entries,
        bytes: size,
        folds: new Map(),
      })
    }
    const from: Cached =
      cached?.source === 'log' && cached.inode === inode && cached.parsedTo <= to
        ? cached
        : { source: 'log', inode, parsedTo: 0, entries: [], bytes: 0, folds: new Map() }
    if (from.parsedTo < to) {
      for (const entry of readEntries(fd, from.parsedTo, to, 0)) from.entries.push(entry)
      from.bytes += to - from.parsedTo
      from.parsedTo = to
    }
    return keep(runId, from)
  }

  function load(runId: string): Cached {
    const log = openLog(runId)
    if (!log) {
      cache.delete(runId)
      return none
    }
    try {
      return fromFile(runId, log)
    } catch (error) {
      console.error(`couldn’t read Run ${runId}’s output:`, error)
      return none
    } finally {
      closeSync(log.fd)
    }
  }

  function* newestFirst(runId: string): Generator<ConversationEntry> {
    const log = cache.has(runId) ? undefined : openLog(runId)
    if (log && log.size >= log.to) {
      try {
        yield* readBackwards(log.fd, log.to)
      } catch (error) {
        console.error(`couldn’t read Run ${runId}’s output:`, error)
      } finally {
        closeSync(log.fd)
      }
      return
    }
    if (log) closeSync(log.fd)
    const { entries } = load(runId)
    for (let i = entries.length - 1; i >= 0; i--) yield entries[i] as ConversationEntry
  }

  return {
    kept(runId) {
      const log = openLog(runId)
      if (!log) return store.runReadOffset(runId) > 0 ? 'none' : 'all'
      closeSync(log.fd)
      return log.size < log.to ? 'tail' : 'all'
    },
    stamp(runId) {
      const log = openLog(runId)
      if (!log) return `none:${store.runReadOffset(runId)}`
      closeSync(log.fd)
      return `${log.inode}:${log.size}:${log.to}`
    },
    entries: (runId) => load(runId).entries.slice(),
    fold<T extends OutputFold>(runId: string, name: string, create: () => T): T {
      const cached = load(runId)
      if (cached === none) return create()
      let held = cached.folds.get(name)
      if (!held) {
        held = { fold: create(), count: 0 }
        cached.folds.set(name, held)
      }
      try {
        for (; held.count < cached.entries.length; held.count++)
          held.fold.add(cached.entries[held.count] as ConversationEntry)
      } catch (error) {
        cached.folds.delete(name)
        throw error
      }
      return held.fold as T
    },
    last(runId, count) {
      const found: ConversationEntry[] = []
      for (const entry of newestFirst(runId)) {
        if (found.length >= count) break
        found.push(entry)
      }
      return found.reverse()
    },
    findLast(runId, matches) {
      for (const entry of newestFirst(runId)) if (matches(entry)) return entry
      return undefined
    },
  }
}

const none: Cached = {
  source: 'log',
  inode: 0,
  parsedTo: 0,
  entries: [],
  bytes: 0,
  folds: new Map(),
}

function readBytes(fd: number, from: number, to: number): Buffer {
  const buffer = Buffer.alloc(to - from)
  let read = 0
  while (read < buffer.length) {
    const bytes = readSync(fd, buffer, read, buffer.length - read, from + read)
    if (bytes === 0) break
    read += bytes
  }
  return buffer.subarray(0, read)
}

function entriesIn(buffer: Buffer, start: number, shift: number): ConversationEntry[] {
  const entries: ConversationEntry[] = []
  for (let pos = 0; pos < buffer.length; ) {
    const newline = buffer.indexOf(10, pos)
    if (newline === -1) break
    const entry = entryFrom(buffer.toString('utf8', pos, newline), start + pos + shift)
    if (entry) entries.push(entry)
    pos = newline + 1
  }
  return entries
}

function entryFrom(text: string, offset: number): ConversationEntry | undefined {
  try {
    const record = JSON.parse(text) as HostRecord
    if (record.t !== 'out' || typeof record.line !== 'string') return undefined
    return {
      offset,
      line: record.line,
      ...(typeof record.at === 'string' && { at: record.at }),
    }
  } catch {
    return undefined
  }
}

function readEntries(fd: number, from: number, to: number, shift: number): ConversationEntry[] {
  const entries: ConversationEntry[] = []
  let pos = from
  let length = chunkBytes
  while (pos < to) {
    const buffer = readBytes(fd, pos, Math.min(to, pos + length))
    const end = buffer.lastIndexOf(10)
    if (end === -1) {
      if (pos + buffer.length >= to || buffer.length === 0) break
      length *= 2
      continue
    }
    for (const entry of entriesIn(buffer.subarray(0, end + 1), pos, shift)) entries.push(entry)
    pos += end + 1
    length = chunkBytes
  }
  return entries
}

function* readBackwards(fd: number, to: number): Generator<ConversationEntry> {
  let end = to
  let carry: Buffer = Buffer.alloc(0)
  while (end > 0) {
    const start = Math.max(0, end - chunkBytes)
    const buffer = Buffer.concat([readBytes(fd, start, end), carry])
    const firstLine = start === 0 ? 0 : buffer.indexOf(10) + 1
    if (start > 0 && firstLine === 0) {
      carry = buffer
      end = start
      continue
    }
    const entries = entriesIn(buffer.subarray(firstLine), start + firstLine, 0)
    for (let i = entries.length - 1; i >= 0; i--) yield entries[i] as ConversationEntry
    carry = buffer.subarray(0, firstLine)
    end = start
  }
}
