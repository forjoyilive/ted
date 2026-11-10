import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import path from 'node:path'
import { type ConversationEntry, tedPaths } from '@ted/protocol'
import type { TedStore } from '../store/index.ts'
import { type HostRecord, runFiles } from './host-files.ts'

export interface RunOutputReader {
  entries(runId: string): ConversationEntry[]
  last(runId: string, count: number): ConversationEntry[]
  findLast(
    runId: string,
    matches: (entry: ConversationEntry) => boolean,
  ): ConversationEntry | undefined
}

export interface RunOutputOptions {
  home: string
  store: Pick<TedStore, 'getRun' | 'runReadOffset' | 'storedConversation'>
  cacheBytes?: number
  cacheRuns?: number
}

const defaultCacheBytes = 64 * 1024 * 1024
const defaultCacheRuns = 64
const chunkBytes = 1024 * 1024

type Source = 'log' | 'tail' | 'stored'

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
}

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
    for (const { bytes } of cache.values()) total += bytes
    for (const [id, { bytes }] of cache) {
      if (cache.size <= 1 || (total <= cacheBytes && cache.size <= cacheRuns)) break
      cache.delete(id)
      total -= bytes
    }
    return cached
  }

  function stored(runId: string): Cached {
    const cached = cache.get(runId)
    if (cached?.source === 'stored') return keep(runId, cached)
    const entries = store.storedConversation(runId)
    return keep(runId, {
      source: 'stored',
      inode: 0,
      parsedTo: 0,
      entries,
      bytes: entries.reduce((sum, entry) => sum + entry.line.length, 0),
    })
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
      const rows = stored(runId)
      if (rows.entries.length > 0) return rows
      const entries = readEntries(fd, 0, size, to - size)
      return keep(runId, { source: 'tail', inode, parsedTo: size, entries, bytes: size })
    }
    const from =
      cached?.source === 'log' && cached.inode === inode && cached.parsedTo <= to
        ? cached
        : { source: 'log' as const, inode, parsedTo: 0, entries: [], bytes: 0 }
    if (from.parsedTo < to) {
      for (const entry of readEntries(fd, from.parsedTo, to, 0)) from.entries.push(entry)
      from.bytes += to - from.parsedTo
      from.parsedTo = to
    }
    return keep(runId, from)
  }

  function load(runId: string): Cached {
    const log = openLog(runId)
    if (!log) return store.getRun(runId) ? stored(runId) : emptyCache
    try {
      return fromFile(runId, log)
    } catch (error) {
      console.error(`couldn’t read Run ${runId}’s output:`, error)
      return stored(runId)
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
    entries: (runId) => load(runId).entries.slice(),
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

const emptyCache: Cached = { source: 'stored', inode: 0, parsedTo: 0, entries: [], bytes: 0 }

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
