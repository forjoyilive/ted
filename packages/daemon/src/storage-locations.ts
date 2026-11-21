import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import {
  access,
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { isObject, isString, parseJson } from '@ted/protocol/parse'
import type {
  StorageFolderChange,
  StorageFolderKind,
  StorageFolderLocation,
} from '@ted/protocol/storage'
import { RequestError } from './errors.ts'

interface Location {
  path: string
  owner: string
}

interface Move {
  kind: StorageFolderKind
  target: Location | null
  id: string
}

interface State {
  backups?: Location
  'sandbox-caches'?: Location
  pending?: Move
  cleanup?: Move
  problem?: string
  problemKind?: StorageFolderKind
}

const marker = '.ted-storage-owner'
const copyMarker = '.ted-storage-copy'

function location(value: ReturnType<typeof parseJson>): Location | undefined {
  if (!isObject(value) || !isString(value.path) || !isString(value.owner)) return undefined
  if (!path.isAbsolute(value.path) || path.normalize(value.path) !== value.path) return undefined
  if (!/^[a-f\d-]{36}$/.test(value.owner)) return undefined
  return { path: value.path, owner: value.owner }
}

function move(value: ReturnType<typeof parseJson>): Move | undefined {
  if (
    !isObject(value) ||
    !isString(value.id) ||
    !/^[a-f\d-]{36}$/.test(value.id) ||
    (value.kind !== 'backups' && value.kind !== 'sandbox-caches')
  ) {
    return undefined
  }
  const target = value.target === null ? null : location(value.target)
  return target === undefined ? undefined : { kind: value.kind, target, id: value.id }
}

function inside(parent: string, child: string): boolean {
  const relative =
    process.platform === 'darwin'
      ? path.relative(parent.toLowerCase(), child.toLowerCase())
      : path.relative(parent, child)
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  )
}

async function plain(dir: string): Promise<boolean> {
  return (
    (await lstat(dir).catch(() => undefined))?.isDirectory() === true &&
    (await realpath(dir).catch(() => undefined)) === dir
  )
}

async function owned(target: Location): Promise<boolean> {
  if (!(await plain(target.path))) return false
  const file = path.join(target.path, marker)
  return (
    (await lstat(file).catch(() => undefined))?.isFile() === true &&
    (await readFile(file, 'utf8').catch(() => undefined)) === target.owner
  )
}

export async function openStorageLocations(tedHome: string, { apply = true } = {}) {
  const home = await realpath(tedHome)
  const filename = path.join(home, 'storage-locations.json')
  let state: State = {}
  const saved = await readFile(filename, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (saved !== undefined) {
    const parsed = parseJson(saved)
    if (!isObject(parsed)) throw new Error('Couldn’t read Ted’s storage locations')
    const backups = location(parsed.backups)
    const caches = location(parsed['sandbox-caches'])
    const pending = move(parsed.pending)
    const cleanup = move(parsed.cleanup)
    state = {
      ...(backups && { backups }),
      ...(caches && { 'sandbox-caches': caches }),
      ...(pending && { pending }),
      ...(cleanup && { cleanup }),
      ...(isString(parsed.problem) && { problem: parsed.problem }),
      ...((parsed.problemKind === 'backups' || parsed.problemKind === 'sandbox-caches') && {
        problemKind: parsed.problemKind,
      }),
    }
  }

  async function save(next: State) {
    const temporary = `${filename}.${randomUUID()}`
    await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx', flush: true })
    await rename(temporary, filename)
    await sync(home)
    state = next
  }

  const defaultPath = (kind: StorageFolderKind) =>
    path.join(home, kind === 'backups' ? 'backups' : 'sandbox')
  const directory = (kind: StorageFolderKind, target: Location | null | undefined) =>
    target === null || target === undefined
      ? defaultPath(kind)
      : kind === 'backups'
        ? path.join(target.path, 'Backups')
        : target.path
  const active = (kind: StorageFolderKind) => directory(kind, state[kind])

  async function requireAvailable(kind: StorageFolderKind) {
    const target = state[kind]
    if (target && (!(await owned(target)) || !(await plain(active(kind))))) {
      throw new RequestError(409, 'Storage folder unavailable. Reconnect the drive and try again.')
    }
  }

  async function removeLegacyCaches() {
    const sandbox = defaultPath('sandbox-caches')
    if (await plain(sandbox)) {
      for (const name of await readdir(sandbox)) {
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) continue
        const dir = path.join(sandbox, name)
        const cache = path.join(dir, 'cache')
        if ((await plain(dir)) && (await plain(cache))) await rm(cache, { recursive: true })
      }
    }
    const seeds = path.join(home, 'seeds')
    if (await plain(seeds)) await rm(seeds, { recursive: true })
  }

  async function finishCleanup() {
    const cleanup = state.cleanup
    if (!cleanup) return
    const { kind, target } = cleanup
    let retired: string | undefined
    try {
      await requireAvailable(kind)
      if (target) {
        retired = path.join(path.dirname(target.path), `.ted-retired-${cleanup.id}`)
        if (await owned(target)) {
          if (await lstat(retired).catch(() => undefined))
            throw new Error('Cleanup folder already exists.')
          await rename(target.path, retired)
          await sync(path.dirname(retired))
        }
        if (!(await owned({ ...target, path: retired })))
          throw new Error('The original folder is unavailable.')
        for (const name of await readdir(retired)) {
          if (name !== marker) await rm(path.join(retired, name), { recursive: true, force: true })
        }
        await sync(retired)
      } else if (kind === 'sandbox-caches') {
        await removeLegacyCaches()
      } else if (await plain(defaultPath(kind))) {
        await rm(defaultPath(kind), { recursive: true })
      }
      const { cleanup: _, problem: _problem, problemKind: _kind, ...rest } = state
      await save(rest)
      if (retired) await rm(retired, { recursive: true }).catch(() => undefined)
    } catch {
      await save({
        ...state,
        problemKind: kind,
        problem:
          'Some files still take up space at the old location. Reconnect the drives and restart Ted to retry cleanup.',
      })
    }
  }

  async function applyPending() {
    const pending = state.pending
    if (!pending || state.problem) return
    const { kind, target, id } = pending
    const destination = directory(kind, target)
    const source = active(kind)
    try {
      await requireAvailable(kind)
      if (target && !(await owned(target))) throw new Error('The destination is unavailable.')
      if (kind === 'backups') {
        await copyBackups(source, destination, id)
      } else if (target) {
        for (const name of ['tasks', 'seeds']) {
          const dir = path.join(target.path, name)
          await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST') throw error
          })
          if (!(await plain(dir))) throw new Error('Choose a plain cache folder.')
        }
        await sync(target.path)
      }
      if (target && !(await owned(target))) throw new Error('The destination is unavailable.')
      if (!(await plain(destination)) && kind === 'backups') {
        throw new Error('The destination is unavailable.')
      }
    } catch {
      await save({
        ...state,
        problemKind: kind,
        problem:
          'Couldn’t change the folder. Ted is still using the current location. Check that the new drive is connected and has enough space, then try again.',
      })
      return
    }
    const { pending: _, problem: _problem, problemKind: _kind, ...rest } = state
    const next: State = { ...rest, cleanup: { kind, target: state[kind] ?? null, id } }
    if (target) next[kind] = target
    else delete next[kind]
    await save(next)
  }

  if (apply) {
    await applyPending()
    await finishCleanup()
  }

  return {
    active,
    configured: (kind: StorageFolderKind) => state[kind]?.path,
    requireAvailable,
    async cachePath(dir: string) {
      const target = state['sandbox-caches']
      if (!target) return dir
      const relative = path.relative(path.join(tedHome, 'sandbox'), dir)
      if (!/^[a-zA-Z0-9_-]+[/\\]cache$/.test(relative)) return dir
      await requireAvailable('sandbox-caches')
      return path.join(target.path, 'tasks', relative)
    },
    async status(kind: StorageFolderKind): Promise<StorageFolderLocation> {
      const available = await requireAvailable(kind).then(
        () => true,
        () => false,
      )
      return {
        kind,
        path: active(kind),
        custom: state[kind] !== undefined,
        available,
        ...(state.problemKind === kind && state.problem && { problem: state.problem }),
      }
    },
    async request({ kind, parent }: StorageFolderChange) {
      if (state.cleanup)
        throw new RequestError(409, 'Ted still needs to clean up the previous location.')
      if (state.pending) {
        const pending = state.pending
        if (!state.problem) throw new RequestError(409, 'A storage change is already pending.')
        const sameTarget =
          parent === null
            ? pending.target === null
            : pending.target !== null &&
              path.dirname(pending.target.path) === (await realpath(parent))
        if (pending.kind !== kind) {
          throw new RequestError(409, 'Resolve the previous folder change first.')
        }
        if (sameTarget && (!pending.target || (await owned(pending.target)))) {
          const { problem: _, problemKind: _kind, ...rest } = state
          await save(rest)
          return
        }
        const previousDestination = directory(kind, pending.target)
        const previousParent = path.dirname(previousDestination)
        if (!pending.target || (await owned(pending.target))) {
          if (
            kind === 'backups' &&
            (await plain(previousDestination)) &&
            (await readFile(path.join(previousDestination, copyMarker), 'utf8').catch(
              () => undefined,
            )) === pending.id
          )
            await rm(previousDestination, { recursive: true })
          const stage = path.join(previousParent, `.ted-backup-copy-${pending.id}`)
          if (await plain(stage)) await rm(stage, { recursive: true })
          if (pending.target && (await plain(pending.target.path))) {
            await rm(pending.target.path, { recursive: true })
          }
        }
        const { pending: _, problem: _problem, problemKind: _kind, ...rest } = state
        await save(rest)
      }
      await requireAvailable(kind)
      let target: Location | null = null
      if (parent !== null) {
        if (!path.isAbsolute(parent)) throw new RequestError(400, 'Choose an absolute folder path.')
        const root = await realpath(parent)
        if (!(await plain(root))) throw new RequestError(400, 'Choose a writable folder.')
        const name = kind === 'backups' ? 'Ted Backups' : 'Ted Sandbox Caches'
        const destination = path.join(root, name)
        if (
          [home, state.backups?.path, state['sandbox-caches']?.path].some(
            (used) =>
              used !== undefined && (inside(used, destination) || inside(destination, used)),
          )
        )
          throw new RequestError(400, 'Choose a folder outside Ted’s existing storage.')
        await access(root, constants.W_OK)
        target = { path: destination, owner: randomUUID() }
        await mkdir(destination, { mode: 0o700 }).catch(() => {
          throw new RequestError(409, `Choose a folder without an existing “${name}” directory.`)
        })
        await writeFile(path.join(destination, marker), target.owner, {
          flag: 'wx',
          mode: 0o600,
          flush: true,
        })
        await sync(destination)
        await sync(root)
      } else if (!state[kind]) {
        throw new RequestError(400, 'Ted is already using the default location.')
      } else if (kind === 'backups') {
        const entries = await readdir(defaultPath(kind)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return []
          throw error
        })
        if (entries.length) throw new RequestError(409, 'The default backup folder must be empty.')
      }
      const { problem: _, problemKind: _kind, ...rest } = state
      await save({ ...rest, pending: { kind, target, id: randomUUID() } })
    },
  }
}

async function copyBackups(source: string, destination: string, id: string) {
  const parent = path.dirname(destination)
  const stage = path.join(parent, `.ted-backup-copy-${id}`)
  if (!(await plain(parent))) throw new Error('The destination is unavailable.')
  if (await plain(destination)) {
    if (
      (await readFile(path.join(destination, copyMarker), 'utf8').catch(() => undefined)) === id
    ) {
      await rm(destination, { recursive: true })
    } else {
      await rmdir(destination)
    }
  } else if (await lstat(destination).catch(() => undefined)) {
    throw new Error('Choose a plain backup folder.')
  }
  if (await plain(stage)) await rm(stage, { recursive: true })
  await mkdir(stage, { mode: 0o700 })
  if (await plain(source)) {
    for (const name of await readdir(source)) {
      if (name === copyMarker) continue
      const from = path.join(source, name)
      const to = path.join(stage, name)
      await cp(from, to, {
        recursive: true,
        force: false,
        errorOnExist: true,
        filter: async (file) => {
          const entry = await lstat(file)
          if (entry.isDirectory() || entry.isFile()) return true
          throw new Error('The backup contains an unexpected file.')
        },
      })
      await verifyCopy(from, to)
    }
  } else if (await lstat(source).catch(() => undefined)) {
    throw new Error('The current backup folder is unavailable.')
  }
  await writeFile(path.join(stage, copyMarker), id, { flag: 'wx', mode: 0o600, flush: true })
  await sync(stage)
  await rename(stage, destination)
  await sync(parent)
}

async function verifyCopy(source: string, destination: string): Promise<void> {
  const info = await lstat(source)
  if (info.isDirectory()) {
    for (const name of await readdir(source)) {
      await verifyCopy(path.join(source, name), path.join(destination, name))
    }
  } else {
    const hash = async (file: string) => {
      const digest = createHash('sha256')
      for await (const bytes of createReadStream(file)) digest.update(bytes)
      return digest.digest('hex')
    }
    const [original, copy] = await Promise.all([hash(source), hash(destination)])
    if (original !== copy) throw new Error('Ted couldn’t verify the copied backup.')
  }
  await sync(destination)
}

async function sync(file: string) {
  const handle = await open(file, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export type StorageLocations = Awaited<ReturnType<typeof openStorageLocations>>
