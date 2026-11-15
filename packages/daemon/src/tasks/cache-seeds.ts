import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { worktreeCommandEnv } from '../command-env.ts'
import { clonePath } from '../factories.ts'
import * as git from '../git.ts'
import { factoryPermissions } from '../permissions.ts'
import { redactSecrets } from '../redact.ts'
import type { Sandbox } from '../sandbox.ts'
import type { StoredFactory, TedStore } from '../store/index.ts'
import type { Workflows } from '../workflow/workflows.ts'
import type { CheckSlots } from './check-slots.ts'
import { runTaskCommand } from './command.ts'
import { plain as plainFolder } from './local-lifecycle.ts'
import { removeInside } from './remove-files.ts'
import { type FactoryRepoEntry, factoryRepos } from './repos.ts'
import { copyFiles } from './worktree.ts'

const execFileAsync = promisify(execFile)

export const lockfiles = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'deno.lock',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'requirements.txt',
  'Gemfile.lock',
  'composer.lock',
  'Podfile.lock',
  'Package.resolved',
  'gradle.lockfile',
  'mix.lock',
]

export interface CacheSeeds {
  startCache(factoryId: string, cache: string): Promise<void>
  remove(factoryId: string): Promise<void>
  close(): Promise<void>
}

interface SeedRecord {
  key: string
  filledAt: string
}

const safeId = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const leftover = /^(fill|next|old)-[0-9a-f]{12}$/

export function createCacheSeeds(options: {
  home: string
  reposDir: string
  logsDir: string
  store: TedStore
  workflows: Workflows
  sandbox: Sandbox
  checkSlots: CheckSlots
  env: () => NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}): CacheSeeds {
  const { store } = options
  const platform = options.platform ?? process.platform
  const root = path.join(options.home, 'seeds')
  const sandboxRoot = path.join(options.home, 'sandbox')
  const locks = new Map<string, Promise<void>>()
  const fills = new Map<string, { done: Promise<void>; stop: AbortController }>()
  const failed = new Map<string, string>()
  const removing = new Set<string>()
  let clones: Promise<boolean> | undefined
  let closed = false

  const folderOf = (factoryId: string) => path.join(root, factoryId)
  const seedOf = (factoryId: string) => path.join(folderOf(factoryId), 'seed')
  const recordOf = (factoryId: string) => path.join(folderOf(factoryId), 'seed.json')

  function locked<T>(factoryId: string, work: () => Promise<T>): Promise<T> {
    const before = locks.get(factoryId) ?? Promise.resolve()
    const run = before.then(work, work)
    const tail = run.then(
      () => {},
      () => {},
    )
    locks.set(factoryId, tail)
    void tail.then(() => {
      if (locks.get(factoryId) === tail) locks.delete(factoryId)
    })
    return run
  }

  function usable(factoryId: string): boolean {
    return (
      !closed &&
      safeId.test(factoryId) &&
      !removing.has(factoryId) &&
      store.getFactory(factoryId) !== undefined &&
      factoryPermissions(store, factoryId) !== 'bypass'
    )
  }

  function canClone(): Promise<boolean> {
    clones ??= filesClone(options.home, [root, sandboxRoot], platform).catch(() => false)
    return clones
  }

  async function readRecord(factoryId: string): Promise<SeedRecord | undefined> {
    const text = await readFile(recordOf(factoryId), 'utf8').catch(() => undefined)
    if (text === undefined) return undefined
    try {
      const parsed = JSON.parse(text) as Partial<SeedRecord>
      return typeof parsed.key === 'string' && typeof parsed.filledAt === 'string'
        ? { key: parsed.key, filledAt: parsed.filledAt }
        : undefined
    } catch {
      return undefined
    }
  }

  async function seedReady(factoryId: string): Promise<boolean> {
    if ((await readRecord(factoryId)) === undefined) return false
    return plainFolder(root, seedOf(factoryId)).then(
      () => true,
      () => false,
    )
  }

  async function cloneInto(factoryId: string, cache: string): Promise<void> {
    const parent = path.dirname(cache)
    await plainFolder(sandboxRoot, parent, true)
    if (await lstat(cache).catch(() => undefined)) return
    const temp = path.join(parent, `cache-seed-${randomBytes(6).toString('hex')}`)
    try {
      await cloneTree(platform, seedOf(factoryId), temp)
      await rename(temp, cache)
    } catch (error) {
      await removeInside(parent, path.basename(temp)).catch(() => undefined)
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') {
        console.error(
          redactSecrets(
            `couldn’t start ${cache} from the Factory’s seed cache: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
      }
    }
  }

  async function wanted(
    factory: StoredFactory,
  ): Promise<{ key: string; entries: FactoryRepoEntry[] } | undefined> {
    const { workflow } = await options.workflows.resolve(factory, { fetch: false })
    const entries = factoryRepos(workflow, factory)
    if (!entries.some((e) => e.setup)) return undefined
    const parts = []
    for (const entry of entries) {
      const clone = clonePath(options.reposDir, entry)
      const base = entry.baseBranch ?? (await git.defaultBranch(clone))
      parts.push({
        repo: entry.repo.toLowerCase(),
        name: entry.name,
        base,
        setup: entry.setup?.run ?? null,
        env: entry.env,
        copy: entry.copy,
        locks: await git.blobIds(clone, `origin/${base}`, lockfiles),
      })
    }
    const key = createHash('sha256').update(JSON.stringify(parts)).digest('hex')
    return { key, entries }
  }

  async function refresh(factoryId: string): Promise<void> {
    if (fills.has(factoryId) || !usable(factoryId)) return
    if (store.newWorkHold() !== undefined || !(await canClone())) return
    const factory = store.getFactory(factoryId)
    if (!factory) return
    const plan = await wanted(factory)
    if (!plan || failed.get(factoryId) === plan.key) return
    if ((await readRecord(factoryId))?.key === plan.key && (await seedReady(factoryId))) return
    if (fills.has(factoryId) || !usable(factoryId)) return
    const stop = new AbortController()
    const done = fill(factory, plan.key, plan.entries, stop.signal)
      .catch((error: unknown) => {
        failed.set(factoryId, plan.key)
        console.error(
          redactSecrets(
            `couldn’t fill the seed cache of ${factory.name}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
      })
      .finally(() => fills.delete(factoryId))
    fills.set(factoryId, { done, stop })
  }

  async function fill(
    factory: StoredFactory,
    key: string,
    entries: FactoryRepoEntry[],
    signal: AbortSignal,
  ): Promise<void> {
    const release = await options.checkSlots.take({ signal })
    if (!release) return
    const folder = folderOf(factory.id)
    const fillName = `fill-${randomBytes(6).toString('hex')}`
    const fillDir = path.join(folder, fillName)
    const made: { clone: string; worktree: string }[] = []
    try {
      if (signal.aborted || !usable(factory.id) || store.newWorkHold() !== undefined) return
      if ((await options.sandbox.problem()) !== undefined) return
      await plainFolder(options.home, fillDir, true)
      for (const name of await readdir(folder)) {
        if (name !== fillName && leftover.test(name)) await removeInside(folder, name)
      }
      const cache = path.join(fillDir, 'cache')
      const repos = path.join(fillDir, 'repos')
      await mkdir(cache, { mode: 0o700 })
      await mkdir(repos, { mode: 0o700 })
      for (const entry of entries) {
        const clone = clonePath(options.reposDir, entry)
        await plainFolder(options.reposDir, clone)
        const base = entry.baseBranch ?? (await git.defaultBranch(clone))
        const worktree = path.join(repos, entry.name)
        await git.addScratchWorktree(clone, worktree, `origin/${base}`)
        made.push({ clone, worktree })
        await copyFiles(store.localFolder(entry.repo), worktree, entry.copy)
      }
      const { workflow } = await options.workflows.resolve(factory, { fetch: false })
      const scope = {
        writable: made.map((m) => m.worktree),
        readable: [...new Set(made.map((m) => m.clone))],
        cache,
        sockets: workflow.settings.sandbox_sockets ?? [],
      }
      for (const [i, entry] of entries.entries()) {
        const repo = made[i]
        if (!entry.setup || !repo) continue
        const result = await runTaskCommand({
          label: 'seed setup',
          command: entry.setup,
          cwd: repo.worktree,
          env: worktreeCommandEnv(entry.env, {}, options.env()),
          log: path.join(options.logsDir, 'seeds', `${factory.id}-${entry.name}-setup.log`),
          signal,
          lowPriority: store.settings().lowPriorityWork,
          sandbox: { sandbox: options.sandbox, scope, tmpRoot: path.join(fillDir, 'tmp') },
        })
        if (result.outcome !== 'passed') {
          throw new Error(`setup for ${entry.name} ended ${result.outcome}`)
        }
      }
      if (signal.aborted || !usable(factory.id)) return
      const next = path.join(folder, `next-${randomBytes(6).toString('hex')}`)
      await cloneTree(platform, cache, next)
      await locked(factory.id, async () => {
        if (!usable(factory.id)) {
          await removeInside(folder, path.basename(next))
          return
        }
        const old = path.join(folder, `old-${randomBytes(6).toString('hex')}`)
        await rm(recordOf(factory.id), { force: true })
        const had = await lstat(seedOf(factory.id)).catch(() => undefined)
        if (had) await rename(seedOf(factory.id), old)
        await rename(next, seedOf(factory.id))
        const temp = `${recordOf(factory.id)}.${randomBytes(6).toString('hex')}`
        const record: SeedRecord = { key, filledAt: new Date().toISOString() }
        await writeFile(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 })
        await rename(temp, recordOf(factory.id))
        if (had) await removeInside(folder, path.basename(old))
      })
      failed.delete(factory.id)
    } finally {
      release()
      for (const { clone, worktree } of made) {
        await git.removeWorktree(clone, worktree).catch(() => undefined)
      }
      await removeInside(folder, fillName).catch(() => undefined)
    }
  }

  return {
    async startCache(factoryId, cache) {
      if (!usable(factoryId)) return
      try {
        if (!(await lstat(cache).catch(() => undefined)) && (await canClone())) {
          await locked(factoryId, async () => {
            if (usable(factoryId) && (await seedReady(factoryId))) {
              await cloneInto(factoryId, cache)
            }
          })
        }
        void refresh(factoryId).catch((error: unknown) =>
          console.error(
            redactSecrets(
              `couldn’t check the seed cache of Factory ${factoryId}: ${error instanceof Error ? error.message : String(error)}`,
            ),
          ),
        )
      } catch (error) {
        console.error(
          redactSecrets(
            `couldn’t start ${cache} from the seed cache: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
      }
    },
    async remove(factoryId) {
      if (!safeId.test(factoryId)) return
      removing.add(factoryId)
      try {
        const running = fills.get(factoryId)
        running?.stop.abort()
        await running?.done
        const plainRoot = await plainFolder(options.home, root).then(
          () => true,
          () => false,
        )
        if (plainRoot) await locked(factoryId, () => removeInside(root, factoryId))
        failed.delete(factoryId)
      } finally {
        removing.delete(factoryId)
      }
    },
    async close() {
      closed = true
      const running = [...fills.values()]
      for (const fill of running) fill.stop.abort()
      await Promise.all(running.map((fill) => fill.done))
    },
  }
}

export async function filesClone(
  home: string,
  dirs: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const [first, ...rest] = dirs
  if (first === undefined) return false
  for (const dir of dirs) {
    const isPlain = await plainFolder(home, dir, true).then(
      () => true,
      () => false,
    )
    if (!isPlain) return false
  }
  const device = (await lstat(first)).dev
  for (const dir of rest) if ((await lstat(dir)).dev !== device) return false
  if (platform === 'darwin') return onApfs(first)
  const id = randomBytes(6).toString('hex')
  const from = path.join(first, `.probe-${id}`)
  const to = path.join(first, `.probe-${id}-clone`)
  try {
    await writeFile(from, 'probe', { mode: 0o600 })
    await copyFile(from, to, constants.COPYFILE_FICLONE_FORCE)
    return true
  } catch {
    return false
  } finally {
    await rm(from, { force: true })
    await rm(to, { force: true })
  }
}

async function onApfs(dir: string): Promise<boolean> {
  const { stdout: df } = await execFileAsync('/bin/df', ['-P', dir])
  const mountPoint = df.trim().split('\n')[1]?.split(/\s+/).slice(5).join(' ')
  if (!mountPoint) return false
  const { stdout: mounts } = await execFileAsync('/sbin/mount')
  return mounts.split('\n').some((line) => line.includes(` on ${mountPoint} (apfs,`))
}

async function cloneTree(platform: NodeJS.Platform, from: string, to: string): Promise<void> {
  const args =
    platform === 'darwin'
      ? ['-c', '-R', '-P', from, to]
      : ['-R', '-P', '--reflink=always', from, to]
  await execFileAsync('/bin/cp', args, { maxBuffer: 1024 * 1024 })
}
