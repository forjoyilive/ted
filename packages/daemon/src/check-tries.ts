import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CheckTry, CheckTryOutput, CheckTryRequest, DaemonEvent } from '@ted/protocol'
import type { Banners } from './banners.ts'
import { loginShell, worktreeCommandEnv } from './command-env.ts'
import { RequestError } from './errors.ts'
import { clonePath } from './factories.ts'
import * as git from './git.ts'
import type { StoredFactory, TedStore } from './store/index.ts'
import { type CheckSlots, checkCpusEnv } from './tasks/check-slots.ts'
import { defaultCheckTimeout, readOutput } from './tasks/checks.ts'
import { removeInside } from './tasks/remove-files.ts'
import { type FactoryRepoEntry, factoryRepos, findRepo, isSafeRepo } from './tasks/repos.ts'
import { copyFiles, durationMs, runWorktreeCommand } from './tasks/worktree.ts'
import type { Workflows } from './workflow/workflows.ts'

export interface CheckTries {
  start(factoryId: string, request: CheckTryRequest): Promise<CheckTry>
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
  maxAgeMs?: number
  env?: () => NodeJS.ProcessEnv
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

  async function removeWorktree(factoryId: string, name: string, repo: string): Promise<void> {
    const root = await worktreesDir(factoryId, false)
    if (root === undefined || !safeName.test(name)) return
    if (isSafeRepo(repo)) {
      await git
        .removeWorktree(clonePath(reposDir, { repo }), path.join(root, name))
        .catch(() => undefined)
    }
    await removeInside(root, name)
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
    await git.addScratchWorktree(clone, worktree, `origin/${base}`)
    const now = new Date().toISOString()
    state.worktrees = [
      ...state.worktrees.filter((w) => w.name !== entry.name),
      { repo: entry.repo, name: entry.name, createdAt: now, usedAt: now },
    ]
    await save(factory.id, state)
    await copyFiles(store.localFolder(entry.repo), worktree, entry.copy).catch(() => undefined)
    if (entry.setup) {
      const result = await runWorktreeCommand({
        command: entry.setup,
        cwd: worktree,
        env: worktreeCommandEnv(entry.env, {}, options.env?.() ?? process.env),
        log,
        signal,
        lowPriority: store.settings().lowPriorityWork,
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
    request: CheckTryRequest,
    started: CheckTry,
    abort: AbortController,
    shownWaiting: boolean,
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
      const prepared = release
        ? await prepare(factory, entry, log, abort.signal)
        : { failed: 'stopped' as const }
      if ('failed' in prepared) {
        finished = {
          ...started,
          state: prepared.failed,
          setupFailed: prepared.failed !== 'stopped',
          ...(prepared.exitCode !== undefined && { exitCode: prepared.exitCode }),
        }
      } else {
        const result = await runWorktreeCommand({
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
      await writeFile(log, `TED couldn’t prepare the scratch worktree: ${message}\n`, {
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
        text: `A Check’s command wasn’t found: \`${request.run}\``,
        action: {
          label: 'Open Factory settings',
          opens: { kind: 'factory-settings', factoryId: factory.id },
        },
      })
    }
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
        throw new RequestError(409, `TED isn’t starting new work right now: ${held}.`)
      }
      if (running.has(factoryId)) {
        throw new RequestError(409, 'A Check is already running here. Stop it first.')
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
        placeholder.done = execute(factory, entry, request, started, placeholder.abort, waits)
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
