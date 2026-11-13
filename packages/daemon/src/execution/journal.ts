import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { type FileHandle, open, rename } from 'node:fs/promises'
import path from 'node:path'
import {
  type ExecutionCommand,
  type ExecutionLimits,
  type ExecutionOperationState,
  type ExecutionRef,
  type ExecutionResult,
  executionLimits,
} from '@ted/protocol'
import { privateDirectory } from './files.ts'

export interface JournaledOperation {
  id: string
  ref: ExecutionRef
  order: number
  state: Exclude<ExecutionOperationState, 'refused'>
  command?: ExecutionCommand
  result?: ExecutionResult
  stopRequested?: boolean
}
export interface JournaledTask {
  assignmentId: string
  reservationId: string
  generation: number
  lastOrder: number
}
type Entry =
  | { t: 'task'; taskId: string; task: JournaledTask }
  | { t: 'accept'; command: ExecutionCommand }
  | { t: 'tombstone'; id: string; ref: ExecutionRef; order: number }
  | { t: 'start' | 'reset' | 'stop' | 'stopped' | 'uncertain' | 'confirm'; id: string }
  | { t: 'finish'; id: string; result: ExecutionResult }

export class JournalFull extends Error {}

const flags = constants.O_NOFOLLOW | constants.O_CREAT | constants.O_APPEND | constants.O_RDWR

export async function openJournal(home: string, limits: ExecutionLimits = executionLimits) {
  const root = await privateDirectory(path.join(home, 'operations'))
  const file = path.join(root, 'journal.jsonl')
  const operations = new Map<string, JournaledOperation>()
  const tasks = new Map<string, JournaledTask>()
  let handle: FileHandle | undefined
  let liveBytes = 0
  let garbageBytes = 0
  let confirms = 0
  let writes = Promise.resolve()

  function note(ref: ExecutionRef, order: number): void {
    const known = tasks.get(ref.taskId)
    tasks.set(ref.taskId, {
      assignmentId: ref.assignmentId,
      reservationId: ref.reservationId,
      generation: ref.generation,
      lastOrder: Math.max(order, known?.lastOrder ?? 0),
    })
  }
  function play(entry: Entry, bytes: number): void {
    if (entry.t === 'task') {
      tasks.set(entry.taskId, entry.task)
      return
    }
    if (entry.t === 'accept') {
      const { command } = entry
      operations.set(command.operationId, {
        id: command.operationId,
        ref: command.ref,
        order: command.order,
        state: 'accepted',
        command,
      })
      note(command.ref, command.order)
      liveBytes += bytes
      return
    }
    if (entry.t === 'tombstone') {
      operations.set(entry.id, {
        id: entry.id,
        ref: entry.ref,
        order: entry.order,
        state: 'stopped',
      })
      note(entry.ref, entry.order)
      liveBytes += bytes
      return
    }
    const operation = operations.get(entry.id)
    if (!operation) {
      garbageBytes += bytes
      return
    }
    if (entry.t === 'confirm') {
      operations.delete(entry.id)
      garbageBytes += bytes
      confirms++
      return
    }
    liveBytes += bytes
    if (entry.t === 'start') operation.state = 'running'
    else if (entry.t === 'reset') operation.state = 'accepted'
    else if (entry.t === 'stop') operation.stopRequested = true
    else if (entry.t === 'stopped') operation.state = 'stopped'
    else if (entry.t === 'uncertain') operation.state = 'uncertain'
    else if (entry.t === 'finish') {
      operation.state = 'finished'
      operation.result = entry.result
    }
  }
  function snapshot(): Entry[] {
    const entries: Entry[] = [...tasks].map(([taskId, task]) => ({ t: 'task', taskId, task }))
    for (const o of operations.values()) {
      if (o.command) entries.push({ t: 'accept', command: o.command })
      else entries.push({ t: 'tombstone', id: o.id, ref: o.ref, order: o.order })
      if (o.stopRequested) entries.push({ t: 'stop', id: o.id })
      if (o.state === 'running') entries.push({ t: 'start', id: o.id })
      else if (o.state === 'uncertain') entries.push({ t: 'uncertain', id: o.id })
      else if (o.state === 'stopped' && o.command) entries.push({ t: 'stopped', id: o.id })
      else if (o.state === 'finished' && o.result)
        entries.push({ t: 'finish', id: o.id, result: o.result })
    }
    return entries
  }
  async function compact(): Promise<void> {
    const text = snapshot()
      .map((e) => `${JSON.stringify(e)}\n`)
      .join('')
    const temporary = path.join(root, `journal.${randomUUID()}.tmp`)
    const next = await open(temporary, 'wx', 0o600)
    try {
      await next.writeFile(text)
      await next.sync()
    } finally {
      await next.close()
    }
    await handle?.close()
    handle = undefined
    await rename(temporary, file)
    const folder = await open(root, constants.O_RDONLY)
    try {
      await folder.sync()
    } finally {
      await folder.close()
    }
    handle = await open(file, flags, 0o600)
    liveBytes = Buffer.byteLength(text)
    garbageBytes = 0
    confirms = 0
  }
  function append(entry: Entry): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`
    const next = writes.then(async () => {
      if (!handle) throw new Error('Execution journal is closed')
      await handle.appendFile(line)
      await handle.sync()
      play(entry, Buffer.byteLength(line))
      if (confirms >= 64 || garbageBytes > 1024 * 1024) await compact()
    })
    writes = next.catch(() => undefined)
    return next
  }

  handle = await open(file, flags, 0o600)
  const info = await handle.stat()
  if (!info.isFile() || (info.mode & 0o077) !== 0)
    throw new Error('Execution journal must be a private regular file')
  const saved = await handle.readFile('utf8')
  for (const line of saved.slice(0, saved.lastIndexOf('\n') + 1).split('\n'))
    if (line) play(JSON.parse(line) as Entry, Buffer.byteLength(line) + 1)
  await compact()

  const unfinished = () =>
    [...operations.values()].filter((o) => o.state === 'accepted' || o.state === 'running').length
  return {
    operations: (): JournaledOperation[] => [...operations.values()],
    operation: (id: string) => operations.get(id),
    task: (taskId: string) => tasks.get(taskId),
    full(extraBytes = 0): boolean {
      return (
        operations.size >= limits.unconfirmed ||
        liveBytes + garbageBytes + (unfinished() + 1) * limits.resultBytes + extraBytes >
          limits.journalBytes
      )
    },
    async accept(command: ExecutionCommand): Promise<void> {
      if (this.full(Buffer.byteLength(JSON.stringify(command)))) throw new JournalFull()
      await append({ t: 'accept', command })
    },
    tombstone: (id: string, ref: ExecutionRef, order: number) =>
      append({ t: 'tombstone', id, ref, order }),
    record: (t: 'start' | 'reset' | 'stop' | 'stopped' | 'uncertain', id: string) =>
      append({ t, id }),
    finish: (id: string, result: ExecutionResult) => append({ t: 'finish', id, result }),
    async confirm(ids: string[]): Promise<void> {
      for (const id of ids) {
        const state = operations.get(id)?.state
        if (state === 'finished' || state === 'stopped') await append({ t: 'confirm', id })
      }
    },
    async close(): Promise<void> {
      await writes
      await handle?.close()
      handle = undefined
    },
  }
}
export type ExecutionJournal = Awaited<ReturnType<typeof openJournal>>
