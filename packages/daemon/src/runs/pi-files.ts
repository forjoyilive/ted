import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { type Attachment, tedPaths } from '@ted/protocol'
import {
  attachmentFilesIn,
  type PiFilesOwner,
  piFilesFolder,
  toPiFiles,
} from '../agents/pi-files.ts'
import type { TedStore } from '../store/index.ts'

type PiFilesStore = Pick<TedStore, 'getTask' | 'taskFiles' | 'taskRunList' | 'runMessages'>

export interface PiFilesInput {
  home: string
  store: PiFilesStore
  runId: string
  taskId: string | undefined
}

function piFilesOwner(input: PiFilesInput): PiFilesOwner {
  const task = input.taskId === undefined ? undefined : input.store.getTask(input.taskId)
  return {
    runId: input.runId,
    ...(task !== undefined && { taskDisplayId: task.displayId }),
  }
}

// The sandbox hides TED_HOME/attachments from a Pi Run, so each file Ted names in a Pi Run's
// text is cloned into the Run's own files folder, which piSandboxScope lets it read.
export async function piFilesText(
  input: PiFilesInput & { text: string; files?: readonly Attachment[] },
): Promise<string> {
  const { home, text } = input
  const found = attachmentFilesIn(home, text)
  if (found.length === 0) return text
  const owner = piFilesOwner(input)
  const owned = ownedHashes(input, owner)
  for (const file of input.files ?? []) owned.add(file.hash)
  const folder = await piFilesFolderMade(home, owner)
  const copied = new Set<string>()
  for (const { hash, name } of found) {
    if (!owned.has(hash) || copied.has(hash)) continue
    if (await cloned(path.join(tedPaths(home).attachments, name), path.join(folder, name)))
      copied.add(hash)
  }
  return toPiFiles(home, folder, text, copied)
}

export async function piFilesFolderMade(home: string, owner: PiFilesOwner): Promise<string> {
  const folder = piFilesFolder(home, owner)
  await mkdir(path.dirname(path.dirname(folder)), { recursive: true, mode: 0o700 })
  for (const dir of [path.dirname(folder), folder]) {
    await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    const found = await lstat(dir)
    if (!found.isDirectory() || found.isSymbolicLink())
      throw new Error(`${dir} isn’t a plain folder, so Ted won’t put Pi’s files there`)
  }
  return folder
}

function ownedHashes(input: PiFilesInput, owner: PiFilesOwner): Set<string> {
  const { store, runId, taskId } = input
  if (owner.taskDisplayId === undefined || taskId === undefined)
    return new Set(messageFiles(store, runId))
  return new Set([
    ...store.taskFiles(taskId).map((a) => a.hash),
    ...store.taskRunList(taskId).flatMap((run) => messageFiles(store, run.id)),
    ...messageFiles(store, runId),
  ])
}

function messageFiles(store: PiFilesStore, runId: string): string[] {
  return store.runMessages(runId).flatMap((m) => (m.attachments ?? []).map((a) => a.hash))
}

async function cloned(source: string, copy: string): Promise<boolean> {
  const present = await lstat(copy).catch(() => undefined)
  if (present?.isFile() === true) return true
  if (present !== undefined) return false
  if ((await lstat(source).catch(() => undefined))?.isFile() !== true) return false
  const partial = `${copy}.${process.pid}.partial`
  try {
    await copyFile(source, partial, constants.COPYFILE_FICLONE)
    await rename(partial, copy)
    return true
  } catch {
    await rm(partial, { force: true })
    return false
  }
}
