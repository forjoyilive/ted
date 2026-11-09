import { constants } from 'node:fs'
import { copyFile, cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { type Backup, type BackupKind, backupKinds, tedPaths } from '@ted/protocol'
import { storeFolder } from './store/files.ts'

export interface EventlogCopy {
  fileName: string
  data: Uint8Array
}

export interface Backups {
  readonly dir: string
  list(): Promise<Backup[]>
  find(name: string): Promise<Backup | undefined>
  takePreUpdate(dataFrom: string | undefined): Promise<Backup>
  saveBeforeRestore(dataFrom: string | undefined): Promise<Backup>
  takeDaily(eventlog: EventlogCopy): Promise<Backup | undefined>
  restore(name: string): Promise<void>
  newestPreUpdate(readableBy: string): Promise<Backup | undefined>
}

interface Manifest extends Omit<Backup, 'name'> {
  attachments?: string[]
}

const keep: Record<BackupKind, number> = { 'pre-update': 3, daily: 7, 'before-restore': 3 }
const namePattern = new RegExp(`^(${backupKinds.join('|')})-\\d{8}(-\\d{6})?(-\\d+)?$`)
const manifestFile = 'backup.json'

export function createBackups(options: {
  home: string
  version: string
  now?: () => Date
}): Backups {
  const paths = tedPaths(options.home)
  const dir = paths.backups
  const attachmentsDir = path.join(dir, 'attachments')
  const now = options.now ?? (() => new Date())

  async function readManifests(): Promise<(Backup & { attachments: string[] })[]> {
    const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []
      throw error
    })
    const found = []
    for (const name of names) {
      if (!namePattern.test(name)) continue
      const manifest = await readFile(path.join(dir, name, manifestFile), 'utf8')
        .then((text) => JSON.parse(text) as Manifest)
        .catch(() => undefined)
      if (!manifest || !backupKinds.includes(manifest.kind)) continue
      found.push({
        name,
        kind: manifest.kind,
        takenAt: manifest.takenAt,
        takenBy: manifest.takenBy,
        ...(manifest.dataFrom !== undefined && { dataFrom: manifest.dataFrom }),
        attachments: manifest.attachments ?? [],
      })
    }
    return found.sort((a, b) => b.takenAt.localeCompare(a.takenAt) || b.name.localeCompare(a.name))
  }

  async function list(): Promise<Backup[]> {
    return (await readManifests()).map(({ attachments: _, ...backup }) => backup)
  }

  async function freeName(kind: BackupKind, at: Date): Promise<string> {
    const stamp = kind === 'daily' ? day(at) : `${day(at)}-${time(at)}`
    const taken = new Set(await readdir(dir))
    let name = `${kind}-${stamp}`
    for (let n = 2; taken.has(name); n++) name = `${kind}-${stamp}-${n}`
    return name
  }

  async function take(
    kind: BackupKind,
    dataFrom: string | undefined,
    fill: (target: string) => Promise<string[] | undefined>,
  ): Promise<Backup> {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const at = now()
    const name = await freeName(kind, at)
    const partial = path.join(dir, `.${name}.partial`)
    await rm(partial, { recursive: true, force: true })
    await mkdir(partial, { mode: 0o700 })
    try {
      const attachments = await fill(partial)
      const manifest: Manifest = {
        kind,
        takenAt: at.toISOString(),
        takenBy: options.version,
        ...(dataFrom !== undefined && { dataFrom }),
        ...(attachments !== undefined && { attachments }),
      }
      await writeFile(path.join(partial, manifestFile), JSON.stringify(manifest, null, 2))
      await rename(partial, path.join(dir, name))
    } catch (error) {
      await rm(partial, { recursive: true, force: true })
      throw error
    }
    await prune(kind)
    return {
      name,
      kind,
      takenAt: at.toISOString(),
      takenBy: options.version,
      ...(dataFrom !== undefined && { dataFrom }),
    }
  }

  async function prune(kind: BackupKind): Promise<void> {
    const ofKind = (await readManifests()).filter((b) => b.kind === kind)
    for (const old of ofKind.slice(keep[kind])) {
      await rm(path.join(dir, old.name), { recursive: true, force: true })
    }
    if (kind !== 'daily') return
    const listed = new Set((await readManifests()).flatMap((b) => b.attachments))
    const files = await readdir(attachmentsDir).catch(() => [])
    for (const file of files) {
      if (!listed.has(file)) await rm(path.join(attachmentsDir, file), { force: true })
    }
  }

  async function copyStore(target: string): Promise<undefined> {
    await cp(paths.store, path.join(target, 'store'), { recursive: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      },
    )
    return undefined
  }

  async function copyAttachments(): Promise<string[]> {
    const files = (await readdir(paths.attachments).catch(() => [])).filter(isHashName)
    await mkdir(attachmentsDir, { recursive: true, mode: 0o700 })
    const have = new Set(await readdir(attachmentsDir))
    for (const file of files) {
      if (have.has(file)) continue
      const tmp = path.join(attachmentsDir, `.${file}.partial`)
      await copyFile(path.join(paths.attachments, file), tmp)
      await rename(tmp, path.join(attachmentsDir, file))
    }
    return files
  }

  const withReason = <T>(work: Promise<T>): Promise<T> =>
    work.catch((error: unknown) => {
      throw new Error(failureReason(error, dir), { cause: error })
    })

  return {
    dir,
    list,
    async find(name) {
      if (!namePattern.test(name)) return undefined
      return (await list()).find((b) => b.name === name)
    },
    takePreUpdate: (dataFrom) => withReason(take('pre-update', dataFrom, copyStore)),
    saveBeforeRestore: (dataFrom) => withReason(take('before-restore', dataFrom, copyStore)),
    async takeDaily(eventlog) {
      return withReason(
        (async () => {
          const today = `daily-${day(now())}`
          if ((await list()).some((b) => b.name === today)) return undefined
          return take('daily', options.version, async (target) => {
            const folder = path.join(target, 'store', storeFolder)
            await mkdir(folder, { recursive: true, mode: 0o700 })
            await writeFile(path.join(folder, path.basename(eventlog.fileName)), eventlog.data, {
              mode: 0o600,
            })
            return copyAttachments()
          })
        })(),
      )
    },
    async restore(name) {
      const backup = (await readManifests()).find((b) => b.name === name)
      if (!backup) throw new Error(`no backup ${name}`)
      const incoming = `${paths.store}.restoring`
      const outgoing = `${paths.store}.replaced`
      await rm(incoming, { recursive: true, force: true })
      await rm(outgoing, { recursive: true, force: true })
      await cp(path.join(dir, name, 'store'), incoming, { recursive: true })
      await rename(paths.store, outgoing).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
      await rename(incoming, paths.store)
      await rm(outgoing, { recursive: true, force: true })
      if (backup.attachments.length > 0) {
        await mkdir(paths.attachments, { recursive: true, mode: 0o700 })
        for (const file of backup.attachments) {
          await copyFile(
            path.join(attachmentsDir, file),
            path.join(paths.attachments, file),
            constants.COPYFILE_EXCL,
          ).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST' && error.code !== 'ENOENT') throw error
          })
        }
      }
    },
    async newestPreUpdate(readableBy) {
      return (await list()).find(
        (b) =>
          b.kind === 'pre-update' &&
          (b.dataFrom === undefined || compareVersions(b.dataFrom, readableBy) <= 0),
      )
    },
  }
}

function isHashName(file: string): boolean {
  return /^[A-Za-z0-9]+$/.test(file)
}

const pad = (n: number) => String(n).padStart(2, '0')
const day = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
const time = (d: Date) => `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`

export function displayPath(file: string): string {
  const home = homedir()
  return file === home || file.startsWith(`${home}${path.sep}`)
    ? `~${file.slice(home.length)}`
    : file
}

export function failureReason(error: unknown, dir: string): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  const where = displayPath(dir)
  if (code === 'ENOTDIR' || code === 'EEXIST') return `${where} isn’t a folder`
  if (code === 'ENOSPC') return 'the disk is full'
  if (code === 'EACCES' || code === 'EPERM') return `TED can’t write to ${where}`
  return error instanceof Error ? error.message : String(error)
}

export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .split(/[.+-]/)
      .slice(0, 3)
      .map((p) => Number.parseInt(p, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}
