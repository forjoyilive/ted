import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import {
  bannerId,
  type ExecutionHandle,
  type ExecutionRef,
  executionHandle,
  executionIds,
} from '@ted/protocol'
import type { Banners } from '../banners.ts'
import { worktreeCommandEnv } from '../command-env.ts'
import { RequestError } from '../errors.ts'
import { clonePath, ensureClone } from '../factories.ts'
import * as git from '../git.ts'
import { acquireFactoryPermissions, factoryPermissions } from '../permissions.ts'
import type { Sandbox } from '../sandbox.ts'
import type { StoredFactory, TedStore } from '../store/index.ts'
import { type CommandLaunch, runTaskCommand } from './command.ts'
import { endTaskProcesses } from './leftovers.ts'
import { removeInside } from './remove-files.ts'
import { type FactoryRepoEntry, isSafeRepo } from './repos.ts'
import { type CommandResult, type CopyResult, copyFiles, type WorktreeCommand } from './worktree.ts'

export interface LifecycleHandle extends ExecutionHandle {
  kind: 'clone' | 'worktree'
}

export interface CreatedWorktree extends CopyResult {
  handle: LifecycleHandle
  name: string
  repo: string
  branch: string
}

export interface ClearedWorktree {
  branch?: string
  branchDeleted: boolean
}

export interface LifecycleCommand {
  kind: 'setup' | 'teardown'
  command: WorktreeCommand
  env: Record<string, string>
  remaining?: readonly LifecycleHandle[]
  signal?: AbortSignal
}

export interface TaskWorktreeLifecycle {
  worktree(ref: ExecutionRef, repo: Repo): LifecycleHandle
  prepare(
    ref: ExecutionRef,
    factory: StoredFactory,
    entry: FactoryRepoEntry,
  ): Promise<LifecycleHandle>
  create(
    clone: LifecycleHandle,
    entry: FactoryRepoEntry,
    branch: string,
    fresh: boolean,
  ): Promise<CreatedWorktree>
  clear(
    clone: LifecycleHandle,
    entry: FactoryRepoEntry,
    keep?: string,
  ): Promise<ClearedWorktree | undefined>
  command(handle: LifecycleHandle, input: LifecycleCommand): Promise<CommandResult>
  remove(handle: LifecycleHandle): Promise<void>
  rollback(made: CreatedWorktree): Promise<void>
  auxiliaryWorktrees(ref: ExecutionRef): LifecycleHandle[]
  legacyWorktree(ref: ExecutionRef): LifecycleHandle | undefined
  cleanFolders(ref: ExecutionRef): Promise<void>
  endProcesses(ref: ExecutionRef): Promise<void>
}

export interface LocalLifecycle extends TaskWorktreeLifecycle {
  localPath(handle: LifecycleHandle): string
}

type Repo = { name: string; repo: string }
type Binding = {
  handle: LifecycleHandle
  file: string
  repo: Repo
  clones?: string[]
  source: 'repo' | 'auxiliary' | 'legacy'
  removal: string | undefined
  pending: boolean
}

export function createLocalLifecycle(options: {
  store: TedStore
  banners: Banners
  reposDir: string
  worktreesDir: string
  logsDir: string
  sandbox: Sandbox
  sandboxSockets: (taskId: string) => Promise<readonly string[]>
  startCache: (factoryId: string, cache: string) => Promise<void>
  env: () => NodeJS.ProcessEnv
}): LocalLifecycle {
  const { store } = options
  const bindings = new Map<string, Binding>()

  function requireLocal(ref: ExecutionRef) {
    const saved = store.execution.require(ref)
    if (saved.machineId !== store.execution.localMachineId) {
      throw new RequestError(409, 'Task execution belongs to another machine')
    }
    const task = store.getTask(ref.taskId)
    if (!task) throw new RequestError(404, 'no such Task')
    return task
  }

  function bind(
    ref: ExecutionRef,
    repo: Repo,
    kind: LifecycleHandle['kind'],
    creating = false,
  ): LifecycleHandle {
    const task = requireLocal(ref)
    if (
      !isSafeRepo(repo.repo) ||
      !/^[A-Za-z0-9_.-]+$/.test(repo.name) ||
      repo.name === '.' ||
      repo.name === '..' ||
      repo.name === 'sub-agents'
    ) {
      throw new RequestError(400, 'invalid worktree name or repo')
    }
    const saved = task.repos.find(
      (r) => !r.removed && r.repo.toLowerCase() === repo.repo.toLowerCase(),
    )
    const recorded =
      saved ?? task.repos.find((r) => r.repo.toLowerCase() === repo.repo.toLowerCase())
    if (kind === 'worktree' && recorded?.removed && !creating)
      throw new RequestError(409, 'unknown execution handle')
    const file =
      kind === 'clone'
        ? clonePath(options.reposDir, repo)
        : (saved?.worktree ?? path.join(options.worktreesDir, task.displayId, repo.name))
    const resource = kind === 'worktree' && saved ? { name: saved.name, repo: saved.repo } : repo
    return remember(
      ref,
      resource,
      kind,
      file,
      undefined,
      'repo',
      creating || recorded === undefined,
    )
  }

  function remember(
    ref: ExecutionRef,
    repo: Repo,
    kind: LifecycleHandle['kind'],
    file: string,
    clones?: string[],
    source: Binding['source'] = 'repo',
    pending = false,
  ): LifecycleHandle {
    const removal =
      kind === 'worktree' && source === 'repo' ? lastRemoval(ref.taskId, repo.name) : undefined
    const id = createHash('sha256')
      .update(
        JSON.stringify([
          ref.taskId,
          ref.machineId,
          ref.assignmentId,
          ref.generation,
          ref.reservationId,
          kind,
          repo.repo.toLowerCase(),
          repo.name,
          file,
          source,
          removal,
        ]),
      )
      .digest('hex')
    const handle = { ...executionHandle({ ...ref, id: executionIds.handle(id) }), kind }
    bindings.set(id, {
      handle,
      file,
      repo: { ...repo },
      ...(clones && { clones }),
      source,
      removal,
      pending,
    })
    return handle
  }

  function lastRemoval(taskId: string, name: string): string | undefined {
    return store
      .taskLog(taskId)
      .findLast((event) => event.name === 'v1.TaskWorktreeRemoved' && event.data.name === name)?.id
  }

  function worktree(ref: ExecutionRef, repo: Repo): LifecycleHandle {
    return bind(ref, repo, 'worktree')
  }

  function binding(handle: LifecycleHandle, kind?: LifecycleHandle['kind']): Binding {
    const task = requireLocal(handle)
    const current = new Set(
      task.repos.filter((r) => !r.removed).map((repo) => bind(handle, repo, handle.kind).id),
    )
    for (const resource of auxiliaryWorktrees(handle)) current.add(resource.id)
    const legacy = legacyWorktree(handle)
    if (legacy) current.add(legacy.id)
    const found = bindings.get(handle.id)
    if (found?.handle.kind === 'worktree') {
      const revoked =
        found.source === 'repo' && found.removal !== lastRemoval(task.id, found.repo.name)
      if (revoked || (!current.has(handle.id) && !found.pending)) {
        bindings.delete(handle.id)
        throw new RequestError(409, 'unknown execution handle')
      }
    }
    if (
      !found ||
      (kind !== undefined && handle.kind !== kind) ||
      found.handle.kind !== handle.kind ||
      found.handle.taskId !== handle.taskId ||
      found.handle.assignmentId !== handle.assignmentId ||
      found.handle.generation !== handle.generation ||
      found.handle.reservationId !== handle.reservationId ||
      found.handle.machineId !== handle.machineId
    )
      throw new RequestError(409, 'unknown execution handle')
    return found
  }

  function localPath(handle: LifecycleHandle): string {
    return binding(handle).file
  }

  async function ready(ref: ExecutionRef) {
    requireLocal(ref)
    await store.persisted()
    return requireLocal(ref)
  }

  async function prepare(
    ref: ExecutionRef,
    factory: StoredFactory,
    entry: FactoryRepoEntry,
  ): Promise<LifecycleHandle> {
    const task = await ready(ref)
    if (task.factoryId !== factory.id) throw new RequestError(409, 'execution Factory mismatch')
    const handle = bind(ref, entry, 'clone')
    const clone = localPath(handle)
    await plain(options.reposDir, path.dirname(clone), true)
    await plain(options.reposDir, clone, false, true)
    await ensureClone(
      { banners: options.banners, reposDir: options.reposDir },
      entry.primary ? factory : { ...factory, repo: entry.repo, cloneUrl: entry.cloneUrl },
    )
    return handle
  }

  async function create(
    clone: LifecycleHandle,
    entry: FactoryRepoEntry,
    branch: string,
    fresh: boolean,
  ): Promise<CreatedWorktree> {
    await ready(clone)
    const source = cloneOf(clone, entry)
    await plain(options.reposDir, source.file)
    await git.fetch(source.file)
    const base = entry.baseBranch ?? (await git.defaultBranch(source.file))
    const handle = bind(clone, entry, 'worktree', true)
    const target = localPath(handle)
    await plain(options.worktreesDir, path.dirname(target), true)
    await plain(options.worktreesDir, target, false, true)
    const add = fresh ? git.addWorktree : git.restoreWorktree
    const task = requireLocal(clone)
    const from = `origin/${base}`
    const tip = await git.revParse(source.file, from).catch(() => undefined)
    const hadBranch = await git.hasLocalBranch(source.file, branch)
    const hadWorktree = (await registered(source.file, target)) !== undefined
    await add(source.file, { path: target, branch, from }).catch(async (error: unknown) => {
      const left = hadWorktree ? undefined : await registered(source.file, target)
      const removed =
        left === undefined ||
        (await remove(handle).then(
          () => true,
          () => false,
        ))
      if (fresh && !hadBranch && removed && tip !== undefined)
        await git.deleteBranchAt(source.file, branch, tip).catch(() => undefined)
      throw new RequestError(
        409,
        `couldn’t make ${task.displayId}’s ${entry.name} worktree from origin/${base}: ${String(error)}`,
      )
    })
    const copy = await copyFiles(store.localFolder(entry.repo), target, entry.copy).catch(
      async (error: unknown) => {
        await remove(handle).catch(() => undefined)
        if (fresh) await git.deleteBranch(source.file, branch).catch(() => undefined)
        throw new RequestError(
          409,
          `couldn’t copy files into ${task.displayId}’s ${entry.name} worktree: ${String(error)}`,
        )
      },
    )
    return { handle, name: entry.name, repo: entry.repo, branch, ...copy }
  }

  function cloneOf(clone: LifecycleHandle, entry: FactoryRepoEntry): Binding {
    const source = binding(clone, 'clone')
    if (
      source.repo.repo.toLowerCase() !== entry.repo.toLowerCase() ||
      source.repo.name !== entry.name
    ) {
      throw new RequestError(409, 'execution repo mismatch')
    }
    return source
  }

  async function registered(
    clone: string,
    target: string,
  ): Promise<git.ListedWorktree | undefined> {
    const real = await realpath(target).catch(() => undefined)
    if (real === undefined) return undefined
    const admin = await realpath(path.join(clone, '.git', 'worktrees')).catch(() => undefined)
    if (admin === undefined) return undefined
    const link = path.join(real, '.git')
    if (!(await lstat(link).catch(() => undefined))?.isFile()) return undefined
    const gitDir = /^gitdir: (.+)$/m.exec(await readFile(link, 'utf8'))?.[1]
    if (gitDir === undefined) return undefined
    const pointsAt = await realpath(path.resolve(real, gitDir)).catch(() => undefined)
    if (pointsAt === undefined || path.dirname(pointsAt) !== admin) return undefined
    for (const listed of await git.listWorktrees(clone)) {
      if ((await realpath(listed.path).catch(() => undefined)) === real) return listed
    }
    return undefined
  }

  async function clear(
    clone: LifecycleHandle,
    entry: FactoryRepoEntry,
    keep?: string,
  ): Promise<ClearedWorktree | undefined> {
    const task = await ready(clone)
    const source = cloneOf(clone, entry)
    await plain(options.reposDir, source.file)
    const handle = bind(clone, entry, 'worktree', true)
    const target = localPath(handle)
    await plain(options.worktreesDir, path.dirname(target), true)
    const found = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    if (!found) return undefined
    const inTheWay = (what: string, keepIt = '') =>
      new RequestError(
        409,
        `${task.displayId} can’t start: ${target} is already there and ${what}. Ted left it alone. ${keepIt}Move or delete it, then start ${task.displayId} again.`,
      )
    if (found.isSymbolicLink()) throw inTheWay('is a link')
    if (!found.isDirectory()) throw inTheWay('is a file')
    await plain(options.worktreesDir, target)
    if ((await readdir(target)).length === 0) return undefined
    const listed = await registered(source.file, target)
    if (!listed) throw inTheWay(`isn’t a worktree of Ted’s ${entry.name} clone`)
    if (listed.locked) throw inTheWay('is a locked worktree')
    const base = entry.baseBranch ?? (await git.defaultBranch(source.file))
    const changes = await git.workingChanges(target, `origin/${base}`).catch(() => undefined)
    if (!changes || changes.head !== listed.head) throw inTheWay('is a worktree Ted couldn’t read')
    const on = listed.branch === undefined ? 'no branch' : `branch ${listed.branch}`
    const uncommitted = changes.files.filter((file) => file.uncommitted).length
    if (uncommitted > 0) {
      throw inTheWay(
        `is a worktree on ${on} with ${uncommitted} uncommitted ${uncommitted === 1 ? 'file' : 'files'}`,
        'Copy out anything you want to keep. ',
      )
    }
    const ahead = changes.mergeBase !== changes.head
    if (ahead && (listed.branch === undefined || listed.branch !== keep)) {
      throw inTheWay(
        `is a worktree on ${on} with commits that aren’t on origin/${base}`,
        'Push or copy out anything you want to keep. ',
      )
    }
    await plain(options.worktreesDir, target)
    await git.removeWorktree(source.file, target)
    bindings.delete(handle.id)
    const stale = !ahead && listed.branch !== keep ? listed.branch : undefined
    const branchDeleted =
      stale !== undefined &&
      (await git.deleteBranchAt(source.file, stale, changes.head).then(
        () => true,
        () => false,
      ))
    return { ...(listed.branch !== undefined && { branch: listed.branch }), branchDeleted }
  }

  async function remove(handle: LifecycleHandle): Promise<void> {
    await ready(handle)
    const target = binding(handle, 'worktree')
    await plain(options.worktreesDir, target.file, false, true)
    const clones = target.clones ?? [clonePath(options.reposDir, target.repo)]
    let failure: unknown
    let removed = false
    for (const clone of clones) {
      try {
        await plain(options.reposDir, clone)
        await git.removeWorktree(clone, target.file)
        removed = true
        break
      } catch (error) {
        failure = error
      }
    }
    if (!removed) throw failure
    bindings.delete(handle.id)
  }

  function auxiliaryWorktrees(ref: ExecutionRef): LifecycleHandle[] {
    const task = requireLocal(ref)
    const factory = store.getFactory(task.factoryId)
    if (!factory) return []
    const clones = [
      ...new Set([factory, ...task.repos].map((repo) => clonePath(options.reposDir, repo))),
    ]
    const own = path.join(options.worktreesDir, task.displayId, 'sub-agents') + path.sep
    return store
      .taskRunList(task.id)
      .filter((run) => run.parentRunId !== undefined && run.cwd.startsWith(own))
      .map((run) =>
        remember(
          ref,
          { name: run.id, repo: factory.repo },
          'worktree',
          run.cwd,
          clones,
          'auxiliary',
        ),
      )
  }

  function legacyWorktree(ref: ExecutionRef): LifecycleHandle | undefined {
    const task = requireLocal(ref)
    if (task.repos.length > 0 || !task.worktree) return undefined
    const factory = store.getFactory(task.factoryId)
    return (
      factory &&
      remember(
        ref,
        { name: factory.name, repo: factory.repo },
        'worktree',
        task.worktree,
        undefined,
        'legacy',
      )
    )
  }

  async function endProcesses(ref: ExecutionRef): Promise<void> {
    const task = await ready(ref)
    await endTaskProcesses(path.dirname(options.worktreesDir), task.displayId)
  }

  async function cleanFolders(ref: ExecutionRef): Promise<void> {
    const task = await ready(ref)
    const home = path.dirname(options.worktreesDir)
    await endTaskProcesses(home, task.displayId)
    const worktrees = await lstat(options.worktreesDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    if (worktrees)
      await plain(
        options.worktreesDir,
        path.join(options.worktreesDir, task.displayId),
        false,
        true,
      )
    const sandboxDir = path.join(home, 'sandbox')
    await plain(home, sandboxDir, false, true)
    await removeInside(options.worktreesDir, task.displayId)
    await removeInside(sandboxDir, task.displayId)
  }

  async function rollback(made: CreatedWorktree): Promise<void> {
    const source = binding(made.handle, 'worktree')
    await remove(made.handle)
    await git.deleteBranch(clonePath(options.reposDir, source.repo), made.branch)
  }

  async function command(handle: LifecycleHandle, input: LifecycleCommand): Promise<CommandResult> {
    const task = await ready(handle)
    const target = binding(handle, 'worktree')
    const log = path.join(
      options.logsDir,
      'worktrees',
      `${task.displayId}-${target.repo.name}-${input.kind}.log`,
    )
    return runTaskCommand({
      label: input.kind,
      command: input.command,
      cwd: target.file,
      env: worktreeCommandEnv(input.env, { TED_TASK: task.displayId }, options.env()),
      log,
      ...(input.signal && { signal: input.signal }),
      lowPriority: store.settings().lowPriorityWork,
      async prepareLaunch(): Promise<CommandLaunch> {
        const release = await acquireFactoryPermissions(store, task.factoryId)
        try {
          const current = requireLocal(handle)
          binding(handle, 'worktree')
          await plain(options.worktreesDir, target.file)
          if (factoryPermissions(store, task.factoryId) === 'bypass') return { release }
          const ref = { problem: 'sandbox-unavailable' as const, factoryId: task.factoryId }
          const problem = await options.sandbox.problem()
          if (problem === undefined) {
            if (store.getBanner(bannerId(ref))) options.banners.clear(ref)
          } else options.banners.raise({ ...ref, severity: 'stops-work', text: problem })
          const handles =
            input.remaining ??
            current.repos.filter((r) => !r.removed).map((r) => worktree(handle, r))
          const live = handles.length > 0 ? handles : [handle]
          for (const resource of live) {
            if (resource.taskId !== handle.taskId || resource.assignmentId !== handle.assignmentId)
              throw new RequestError(409, 'execution scope mismatch')
          }
          const resources = live.map((resource) => binding(resource, 'worktree'))
          const sandboxDir = path.join(
            path.dirname(options.worktreesDir),
            'sandbox',
            task.displayId,
          )
          const cache = path.join(sandboxDir, 'cache')
          await options.startCache(task.factoryId, cache)
          return {
            release,
            sandbox: {
              sandbox: options.sandbox,
              scope: {
                writable: resources.map((r) => r.file),
                readable: [...new Set(resources.map((r) => clonePath(options.reposDir, r.repo)))],
                cache,
                sockets: await options.sandboxSockets(task.id),
              },
              tmpRoot: sandboxDir,
            },
          }
        } catch (error) {
          release()
          throw error
        }
      },
    })
  }

  return {
    worktree,
    localPath,
    prepare,
    create,
    clear,
    command,
    remove,
    auxiliaryWorktrees,
    legacyWorktree,
    cleanFolders,
    endProcesses,
    rollback,
  }
}

export async function plain(
  root: string,
  target: string,
  create = false,
  missingLeaf = false,
): Promise<void> {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new RequestError(409, 'execution folder is outside its root')
  }
  if (create) await mkdir(root, { recursive: true })
  const canonical = await realpath(root)
  if (!(await lstat(root)).isDirectory())
    throw new RequestError(409, 'execution root is not a plain folder')
  let current = canonical
  const parts = relative.split(path.sep)
  for (const [i, part] of parts.entries()) {
    current = path.join(current, part)
    let found = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    if (!found && create) {
      await mkdir(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
      found = await lstat(current)
    }
    if (!found && missingLeaf && i === parts.length - 1) return
    if (!found?.isDirectory() || found.isSymbolicLink())
      throw new RequestError(409, `${current} isn’t a plain folder`)
  }
}
