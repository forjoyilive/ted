import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  bannerId,
  type CheckTry,
  type CheckTryOutput,
  type CheckTryRequest,
  type CheckTryState,
  type CheckTryTask,
  type CommandCheckTryRequest,
  type DaemonEvent,
  type InstructionCheckTryRequest,
  isInstructionTry,
} from '@ted/protocol'
import type { Banners } from './banners.ts'
import { makeCopy, removeCopy } from './code-copy.ts'
import { loginShell, worktreeCommandEnv } from './command-env.ts'
import { RequestError } from './errors.ts'
import { clonePath } from './factories.ts'
import * as git from './git.ts'
import { acquireFactoryPermissions, factoryPermissions } from './permissions.ts'
import { redactSecrets } from './redact.ts'
import { type Sandbox, type SandboxGrants, sandboxGrants } from './sandbox.ts'
import type { StoredFactory, TedStore } from './store/index.ts'
import { type CheckSlots, checkCpusEnv } from './tasks/check-slots.ts'
import { defaultCheckTimeout, readOutput } from './tasks/checks.ts'
import { type CommandLaunch, runTaskCommand } from './tasks/command.ts'
import { removeInside } from './tasks/remove-files.ts'
import { type FactoryRepoEntry, factoryRepos, findRepo, isSafeRepo } from './tasks/repos.ts'
import { durationMs } from './tasks/worktree.ts'
import type { Workflows } from './workflow/workflows.ts'

export interface InstructionTries {
  tasks(factoryId: string): Promise<CheckTryTask[]>
  run(
    factoryId: string,
    request: InstructionCheckTryRequest,
    log: string,
    signal: AbortSignal,
  ): Promise<{ state: CheckTryState; taskDisplayId: string; noReport?: string }>
}

export interface CheckTries {
  start(factoryId: string, request: CheckTryRequest): Promise<CheckTry>
  tasks(factoryId: string): Promise<CheckTryTask[]>
  stop(factoryId: string, name: string): void
  list(factoryId: string): Promise<CheckTry[]>
  output(factoryId: string, name: string): Promise<CheckTryOutput>
  sweep(): Promise<void>
  forget(factoryId: string): Promise<void>
  close(): Promise<void>
}

interface ScratchWorktree {
  repo: string
  name: string
  createdAt: string
  usedAt: string
}

interface ScratchState {
  worktrees: ScratchWorktree[]
  tries: CheckTry[]
}

export const scratchMaxAgeMs = 24 * 60 * 60 * 1000
const safeId = /^[A-Za-z0-9_-]+$/
const safeName = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

export function createCheckTries(options: {
  store: TedStore
  checkSlots: CheckSlots
  banners: Banners
  workflows: Workflows
  reposDir: string
  scratchDir: string
  emit: (event: DaemonEvent) => void
  sandbox: Sandbox
  maxAgeMs?: number
  env?: () => NodeJS.ProcessEnv
  instructions?: () => InstructionTries | undefined
}): CheckTries {
  const { store, banners, workflows, reposDir, scratchDir, emit } = options
  const maxAgeMs = options.maxAgeMs ?? scratchMaxAgeMs
  const states = new Map<string, ScratchState>()
  const running = new Map<string, { name: string; abort: AbortController; done: Promise<void> }>()
  let sweeping: Promise<void> = Promise.resolve()

  const factoryDir = (factoryId: string) => {
    if (!safeId.test(factoryId)) throw new RequestError(400, 'no such Factory')
    return path.join(scratchDir, factoryId)
  }
  const stateFile = (factoryId: string) => path.join(factoryDir(factoryId), 'state.json')
  const logFile = (factoryId: string, name: string) =>
    path.join(
      factoryDir(factoryId),
      'logs',
      `${createHash('sha256').update(name).digest('hex').slice(0, 16)}.log`,
    )

  async function load(factoryId: string): Promise<ScratchState> {
    const known = states.get(factoryId)
    if (known) return known
    const text = await readFile(stateFile(factoryId), 'utf8').catch(() => undefined)
    let state: ScratchState = { worktrees: [], tries: [] }
    try {
      if (text !== undefined) state = JSON.parse(text) as ScratchState
    } catch {}
    state.tries = state.tries.map(({ waiting: _, ...t }) =>
      t.state === 'running' ? { ...t, state: 'stopped' } : t,
    )
    states.set(factoryId, state)
    return state
  }

  async function save(factoryId: string, state: ScratchState): Promise<void> {
    const file = stateFile(factoryId)
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 })
    await rename(temporary, file)
  }

  async function update(factoryId: string, checkTry: CheckTry): Promise<void> {
    const state = await load(factoryId)
    state.tries = [...state.tries.filter((t) => t.name !== checkTry.name), checkTry]
    await save(factoryId, state)
    emit({ type: 'check-try-updated', checkTry })
  }

  async function worktreesDir(factoryId: string, create: boolean): Promise<string | undefined> {
    const dirs = [factoryDir(factoryId), path.join(factoryDir(factoryId), 'worktrees')]
    for (const dir of dirs) {
      if (create) await mkdir(dir, { mode: 0o700 }).catch(() => undefined)
      const entry = await lstat(dir).catch(() => undefined)
      if (!entry?.isDirectory()) return undefined
    }
    return dirs[1]
  }

  async function sandboxProblem(factory: StoredFactory): Promise<string | undefined> {
    if (factoryPermissions(store, factory.id) === 'bypass') return undefined
    const ref = { problem: 'sandbox-unavailable' as const, factoryId: factory.id }
    const problem = await options.sandbox.problem()
    if (problem === undefined) {
      if (store.getBanner(bannerId(ref))) banners.clear(ref)
    } else banners.raise({ ...ref, severity: 'stops-work', text: problem })
    return problem
  }

  function launcher(
    factory: StoredFactory,
    entry: FactoryRepoEntry,
    grants: SandboxGrants,
  ): () => Promise<CommandLaunch> {
    return async () => {
      const release = await acquireFactoryPermissions(store, factory.id)
      try {
        if (factoryPermissions(store, factory.id) === 'bypass') return { release }
        const problem = await sandboxProblem(factory)
        if (problem !== undefined) throw new Error(problem)
        const folder = path.join(factoryDir(factory.id), 'sandbox')
        return {
          release,
          sandbox: {
            sandbox: options.sandbox,
            scope: {
              writable: [path.join(factoryDir(factory.id), 'worktrees', entry.name)],
              readable: [clonePath(reposDir, entry)],
              cache: path.join(folder, 'cache'),
              ...grants,
            },
            tmpRoot: path.join(folder, 'tmp'),
          },
        }
      } catch (error) {
        release()
        throw error
      }
    }
  }

  async function removeWorktree(factoryId: string, name: string, repo: string): Promise<void> {
    const root = await worktreesDir(factoryId, false)
    if (root === undefined || !safeName.test(name)) return
    const made = isSafeRepo(repo)
      ? [{ clone: clonePath(reposDir, { repo }), worktree: path.join(root, name) }]
      : []
    await removeCopy(made, root, name)
  }

  async function sweepFactory(factoryId: string, now: number): Promise<void> {
    if (running.has(factoryId)) return
    const state = await load(factoryId)
    const factory = store.getFactory(factoryId)
    const kept: ScratchWorktree[] = []
    for (const worktree of state.worktrees) {
      const old = now - Date.parse(worktree.usedAt) >= maxAgeMs
      if (factory && !old) kept.push(worktree)
      else await removeWorktree(factoryId, worktree.name, worktree.repo)
    }
    if (kept.length === 0) {
      states.delete(factoryId)
      await removeInside(scratchDir, factoryId)
      return
    }
    if (kept.length !== state.worktrees.length) {
      state.worktrees = kept
      await save(factoryId, state)
    }
  }

  function sweep(): Promise<void> {
    sweeping = sweeping.then(async () => {
      const now = Date.now()
      const dirs = await readdir(scratchDir).catch(() => [] as string[])
      for (const dir of dirs) {
        if (!safeId.test(dir)) continue
        if (!(await lstat(path.join(scratchDir, dir)).catch(() => undefined))?.isDirectory())
          continue
        await sweepFactory(dir, now).catch((error: unknown) =>
          console.error(`couldn’t clean up scratch worktrees for ${dir}:`, error),
        )
      }
    })
    return sweeping
  }

  async function prepare(
    factory: StoredFactory,
    entry: FactoryRepoEntry,
    log: string,
    signal: AbortSignal,
    prepareLaunch: () => Promise<CommandLaunch>,
  ): Promise<{ worktree: string } | { failed: CheckTry['state']; exitCode?: number }> {
    const clone = clonePath(reposDir, entry)
    if (!entry.primary) await git.fetch(clone).catch(() => undefined)
    const base = entry.baseBranch ?? (await git.defaultBranch(clone))
    const root = await worktreesDir(factory.id, true)
    if (root === undefined) throw new Error('the scratch folder isn’t a plain folder')
    const worktree = path.join(root, entry.name)
    const state = await load(factory.id)
    const known = state.worktrees.find((w) => w.name === entry.name)
    const exists = (await lstat(worktree).catch(() => undefined))?.isDirectory() === true
    if (known && exists && known.repo.toLowerCase() === entry.repo.toLowerCase()) {
      await git.resetScratchWorktree(worktree, `origin/${base}`)
      known.usedAt = new Date().toISOString()
      await save(factory.id, state)
      return { worktree }
    }
    await removeWorktree(factory.id, entry.name, known?.repo ?? entry.repo)
    await makeCopy(
      { reposDir, store },
      {
        folder: root,
        factory,
        entries: [entry],
        branch: 'base',
        clone: 'existing',
        fetch: 'none',
        copyFiles: 'ignore-errors',
      },
    )
    const now = new Date().toISOString()
    state.worktrees = [
      ...state.worktrees.filter((w) => w.name !== entry.name),
      { repo: entry.repo, name: entry.name, createdAt: now, usedAt: now },
    ]
    await save(factory.id, state)
    if (entry.setup) {
      const result = await runTaskCommand({
        label: 'setup',
        command: entry.setup,
        cwd: worktree,
        env: worktreeCommandEnv(entry.env, {}, options.env?.() ?? process.env),
        log,
        signal,
        lowPriority: store.settings().lowPriorityWork,
        prepareLaunch,
      })
      if (result.outcome !== 'passed') {
        await removeWorktree(factory.id, entry.name, entry.repo)
        state.worktrees = state.worktrees.filter((w) => w.name !== entry.name)
        await save(factory.id, state)
        return {
          failed: result.outcome === 'interrupted' ? 'stopped' : result.outcome,
          ...(result.exitCode !== undefined && { exitCode: result.exitCode }),
        }
      }
    }
    return { worktree }
  }

  async function execute(
    factory: StoredFactory,
    entry: FactoryRepoEntry,
    request: CommandCheckTryRequest,
    started: CheckTry,
    abort: AbortController,
    shownWaiting: boolean,
    grants: SandboxGrants,
  ): Promise<void> {
    const log = logFile(factory.id, request.name)
    await mkdir(path.dirname(log), { recursive: true, mode: 0o700 })
    const waits = options.checkSlots.full()
    const taking = options.checkSlots.take({ signal: abort.signal })
    let finished: CheckTry
    try {
      if (waits !== shownWaiting) {
        await update(factory.id, waits ? { ...started, waiting: true } : started)
      }
      const release = await taking
      if (release && waits) await update(factory.id, started)
      const problem = release ? await sandboxProblem(factory) : undefined
      if (problem !== undefined) {
        await writeFile(log, `${redactSecrets(problem)}\n`, { mode: 0o600 })
      }
      const prepareLaunch = launcher(factory, entry, grants)
      const prepared = !release
        ? { failed: 'stopped' as const }
        : problem !== undefined
          ? { failed: 'failed' as const }
          : await prepare(factory, entry, log, abort.signal, prepareLaunch)
      if ('failed' in prepared) {
        finished = {
          ...started,
          state: prepared.failed,
          setupFailed: prepared.failed !== 'stopped',
          ...(prepared.exitCode !== undefined && { exitCode: prepared.exitCode }),
        }
      } else {
        const result = await runTaskCommand({
          label: 'the check',
          command: {
            run: request.run,
            timeoutMs: durationMs(request.timeout ?? defaultCheckTimeout),
          },
          cwd: prepared.worktree,
          env: worktreeCommandEnv(
            entry.env,
            { CI: '1', ...checkCpusEnv(options.checkSlots.cpus()) },
            options.env?.() ?? process.env,
          ),
          log,
          shell: [loginShell(options.env?.() ?? process.env), '-lc'],
          signal: abort.signal,
          lowPriority: store.settings().lowPriorityWork,
          prepareLaunch,
        })
        finished = {
          ...started,
          state: result.outcome === 'interrupted' ? 'stopped' : result.outcome,
          ...(result.exitCode !== undefined && { exitCode: result.exitCode }),
        }
        const state = await load(factory.id)
        const used = state.worktrees.find((w) => w.name === entry.name)
        if (used) used.usedAt = new Date().toISOString()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await writeFile(log, `Ted couldn’t prepare the scratch worktree: ${message}\n`, {
        mode: 0o600,
      }).catch(() => undefined)
      finished = abort.signal.aborted
        ? { ...started, state: 'stopped' }
        : { ...started, state: 'failed', setupFailed: true }
    } finally {
      void taking.then((release) => release?.())
    }
    const finishedAt = new Date()
    await update(factory.id, {
      ...finished,
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - Date.parse(started.startedAt),
    })
    if (finished.exitCode === 127 && finished.setupFailed !== true) {
      banners.raise({
        problem: 'setup-suggested',
        factoryId: factory.id,
        subject: 'check-not-found',
        severity: 'warning',
        text: `A check’s command wasn’t found: \`${request.run}\``,
        action: {
          label: 'Open Factory settings',
          opens: { kind: 'factory-settings', factoryId: factory.id },
        },
      })
    }
  }

  async function executeInstruction(
    factory: StoredFactory,
    request: InstructionCheckTryRequest,
    started: CheckTry,
    abort: AbortController,
  ): Promise<void> {
    const log = logFile(factory.id, request.name)
    await mkdir(path.dirname(log), { recursive: true, mode: 0o700 })
    let finished: CheckTry
    try {
      const runner = options.instructions?.()
      if (!runner) throw new Error('Ted is still starting')
      const result = await runner.run(factory.id, request, log, abort.signal)
      finished = {
        ...started,
        state: result.state,
        taskDisplayId: result.taskDisplayId,
        ...(result.noReport !== undefined && { noReport: result.noReport }),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await writeFile(log, `Ted couldn’t run this check on the Task: ${message}\n`, {
        mode: 0o600,
      }).catch(() => undefined)
      finished = { ...started, state: abort.signal.aborted ? 'stopped' : 'failed' }
    }
    const finishedAt = new Date()
    await update(factory.id, {
      ...finished,
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - Date.parse(started.startedAt),
    })
  }

  const sweepTimer = setInterval(() => void sweep(), Math.min(maxAgeMs, 60 * 60 * 1000))
  sweepTimer.unref()
  void sweep()

  return {
    async start(factoryId, request) {
      const factory = store.getFactory(factoryId)
      if (!factory) throw new RequestError(404, 'no such Factory')
      if (factory.clonedAt === undefined) {
        throw new RequestError(409, `${factory.name} is still being cloned`)
      }
      const held = store.newWorkHold()
      if (held !== undefined) {
        throw new RequestError(409, `Ted isn’t starting new work right now: ${held}.`)
      }
      if (running.has(factoryId)) {
        throw new RequestError(409, 'A check is already running here. Stop it first.')
      }
      const placeholder = {
        name: request.name,
        abort: new AbortController(),
        done: Promise.resolve(),
      }
      running.set(factoryId, placeholder)
      try {
        await sweeping
        const { workflow } = await workflows.resolve(factory, { fetch: true })
        const entries = factoryRepos(workflow, factory)
        if (isInstructionTry(request)) {
          const runner = options.instructions?.()
          if (!runner) throw new RequestError(503, 'Ted is still starting')
          const task = (await runner.tasks(factoryId)).find((t) => t.id === request.taskId)
          if (!task)
            throw new RequestError(
              409,
              'Run now needs an open Task in this Factory with a worktree that has changes',
            )
          const started: CheckTry = {
            factoryId,
            name: request.name,
            repo: entries[0]?.name ?? '',
            state: 'running',
            startedAt: new Date().toISOString(),
            instruction: true,
            taskId: task.id,
            taskDisplayId: task.displayId,
          }
          await update(factoryId, started)
          placeholder.done = (async () => {
            try {
              await executeInstruction(factory, request, started, placeholder.abort)
            } catch (error) {
              console.error('an instruction check tried from settings failed:', error)
            } finally {
              if (running.get(factoryId) === placeholder) running.delete(factoryId)
            }
          })()
          return started
        }
        const entry = request.repo === undefined ? entries[0] : findRepo(entries, request.repo)
        if (!entry)
          throw new RequestError(
            400,
            `${request.repo ?? 'The repo'} isn’t one of this Factory’s repos`,
          )
        const started: CheckTry = {
          factoryId,
          name: request.name,
          repo: entry.name,
          state: 'running',
          startedAt: new Date().toISOString(),
        }
        const waits = options.checkSlots.full()
        const shown = waits ? { ...started, waiting: true } : started
        await update(factoryId, shown)
        const grants = sandboxGrants(workflow.settings)
        placeholder.done = execute(
          factory,
          entry,
          request,
          started,
          placeholder.abort,
          waits,
          grants,
        )
          .catch((error: unknown) => console.error('a check tried from settings failed:', error))
          .finally(() => {
            if (running.get(factoryId) === placeholder) running.delete(factoryId)
          })
        return shown
      } catch (error) {
        running.delete(factoryId)
        throw error
      }
    },
    async tasks(factoryId) {
      if (!store.getFactory(factoryId)) throw new RequestError(404, 'no such Factory')
      return (await options.instructions?.()?.tasks(factoryId)) ?? []
    },
    stop(factoryId, name) {
      const current = running.get(factoryId)
      if (!current || current.name !== name) {
        throw new RequestError(409, `${name} isn’t running`)
      }
      current.abort.abort()
    },
    async list(factoryId) {
      return (await load(factoryId)).tries
    },
    async output(factoryId, name) {
      const log = logFile(factoryId, name)
      if (!(await load(factoryId)).tries.some((t) => t.name === name)) {
        throw new RequestError(404, `${name} hasn’t run here`)
      }
      return { text: await readOutput(log), log }
    },
    sweep,
    async forget(factoryId) {
      const current = running.get(factoryId)
      current?.abort.abort()
      await current?.done.catch(() => undefined)
      sweeping = sweeping
        .then(async () => {
          const state = await load(factoryId)
          for (const worktree of state.worktrees) {
            await removeWorktree(factoryId, worktree.name, worktree.repo)
          }
          states.delete(factoryId)
          await removeInside(scratchDir, factoryId)
        })
        .catch((error: unknown) =>
          console.error(`couldn’t remove the scratch worktrees of ${factoryId}:`, error),
        )
      await sweeping
    },
    async close() {
      clearInterval(sweepTimer)
      for (const current of running.values()) current.abort.abort()
      await Promise.all([...running.values()].map((r) => r.done))
      await sweeping
    },
  }
}
