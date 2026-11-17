import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  type AutomationCheck,
  type AutomationCheckState,
  type AutomationRunOutput,
  bannerId,
  tedPaths,
} from '@ted/protocol'
import type { Banners } from '../banners.ts'
import { RequestError } from '../errors.ts'
import type { MemoryWatch } from '../memory-kills.ts'
import { acquireFactoryPermissions, factoryPermissions } from '../permissions.ts'
import { redactSecrets } from '../redact.ts'
import type { Sandbox } from '../sandbox.ts'
import type { StoredFactory, TedStore } from '../store/index.ts'
import type { CheckSlots } from '../tasks/check-slots.ts'
import { lastLines, readOutput, runChecks } from '../tasks/checks.ts'
import type { CommandLaunch } from '../tasks/command.ts'
import { removeInside } from '../tasks/remove-files.ts'
import { SetupFailed } from '../tasks/scratch-setup.ts'
import type { Checkouts } from './checkout.ts'

export const memoryStopMessage =
  'This computer ran out of memory, so the Scheduled Check was stopped. TED didn’t count it as a failure.'

export interface ScheduledCheckResult {
  state: AutomationCheckState | 'stopped'
  outOfMemory?: true
  exitCode?: number
  durationMs: number
  commit?: string
  log: string
  output: string
  tail: string
}

export interface ScheduledChecks {
  run(input: {
    automationId: string
    name: string
    factory: StoredFactory
    check: AutomationCheck
    firingId: string
    signal: AbortSignal
    onWaiting: (waiting: boolean) => void
    onStarted: () => void
  }): Promise<ScheduledCheckResult>
  output(automationId: string, firingId: string): Promise<AutomationRunOutput>
  saved(
    automationId: string,
    firingId: string,
  ): Promise<{ log: string; output: string; tail: string }>
  remove(automationId: string): Promise<void>
}

export const keptLogs = 30
const safeId = /^[A-Za-z0-9_-]+$/

export function createScheduledChecks(options: {
  home: string
  store: TedStore
  checkSlots: CheckSlots
  checkouts: Checkouts
  sandbox: Sandbox
  banners: Banners
  libraryDir: string
  env: () => NodeJS.ProcessEnv
  memory?: MemoryWatch
}): ScheduledChecks {
  const { store, banners, checkouts } = options
  const logsRoot = path.join(tedPaths(options.home).logs, 'automation-checks')

  const logDir = (automationId: string) => {
    if (!safeId.test(automationId)) throw new RequestError(400, 'no such Automation')
    return path.join(logsRoot, automationId)
  }
  const logOf = (automationId: string, firingId: string) => {
    if (!safeId.test(firingId)) throw new RequestError(400, 'no such Automation Run')
    return path.join(logDir(automationId), `${firingId}.log`)
  }

  async function plainDirs(dirs: readonly string[]): Promise<void> {
    for (const dir of dirs) {
      await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
      const entry = await lstat(dir)
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`${dir} isn’t a plain folder`)
      }
    }
  }

  async function pruneLogs(automationId: string): Promise<void> {
    const dir = logDir(automationId)
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const logs: { name: string; at: number }[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.log')) continue
      const stats = await lstat(path.join(dir, entry.name)).catch(() => undefined)
      if (stats) logs.push({ name: entry.name, at: stats.mtimeMs })
    }
    logs.sort((a, b) => b.at - a.at)
    for (const old of logs.slice(keptLogs)) await removeInside(dir, old.name)
  }

  function launcher(factory: StoredFactory, firingId: string): () => Promise<CommandLaunch> {
    return async () => {
      const release = await acquireFactoryPermissions(store, factory.id)
      try {
        if (factoryPermissions(store, factory.id) === 'bypass') return { release }
        const ref = { problem: 'sandbox-unavailable' as const, factoryId: factory.id }
        const problem = await options.sandbox.problem()
        if (problem === undefined) {
          if (store.getBanner(bannerId(ref))) banners.clear(ref)
        } else banners.raise({ ...ref, severity: 'stops-work', text: problem })
        const { sandbox: scope } = await checkouts.appTask(firingId)
        if (!scope) throw new Error('the checkout has no sandbox scope')
        return {
          release,
          sandbox: {
            sandbox: options.sandbox,
            scope,
            tmpRoot: path.join(options.home, 'sandbox', firingId),
          },
        }
      } catch (error) {
        release()
        throw error
      }
    }
  }

  return {
    async run({ automationId, name, factory, check, firingId, signal, onWaiting, onStarted }) {
      const log = logOf(automationId, firingId)
      await plainDirs([tedPaths(options.home).logs, logsRoot, logDir(automationId)])
      const waits = options.checkSlots.full()
      if (waits) onWaiting(true)
      const release = await options.checkSlots.take({ signal })
      if (waits) onWaiting(false)
      const stopped = (): ScheduledCheckResult => ({
        state: 'stopped',
        durationMs: 0,
        log,
        output: '',
        tail: '',
      })
      if (!release) return stopped()
      const started = Date.now()
      const failed = async (message: string): Promise<ScheduledCheckResult> => {
        const text = redactSecrets(message)
        await writeFile(log, `${text}\n`, { mode: 0o600 }).catch(() => undefined)
        return {
          state: 'setup-failed',
          durationMs: Date.now() - started,
          log,
          output: text,
          tail: text,
        }
      }
      try {
        onStarted()
        const held = store.newWorkHold()
        if (held !== undefined)
          return await failed(`TED isn’t starting new work right now: ${held}`)
        if (factoryPermissions(store, factory.id) !== 'bypass') {
          const problem = await options.sandbox.problem()
          if (problem !== undefined) {
            banners.raise({
              problem: 'sandbox-unavailable',
              factoryId: factory.id,
              severity: 'stops-work',
              text: problem,
            })
            return await failed(problem)
          }
        }
        const checkout = await checkouts.make({
          runId: firingId,
          automationId,
          name,
          factory,
          signal,
        })
        if (signal.aborted) return stopped()
        const [primary] = checkout.repos
        if (!primary) return await failed('This Factory has no repo to check out.')
        let finished: { state: string; exitCode?: number } | undefined
        const result = await runChecks({
          checks: [
            {
              check: {
                name: 'Scheduled Check',
                command: check.command,
                timeout: check.timeout,
                state: 'waiting',
              },
              cwd: primary.worktree,
              env: primary.env,
            },
          ],
          libraryDir: options.libraryDir,
          env: options.env(),
          logFor: () => log,
          prepareLaunch: launcher(factory, firingId),
          signal,
          lowPriority: store.settings().lowPriorityWork,
          ...(store.settings().limitScheduledCheckCpus && {
            cpus: () => options.checkSlots.cpus(),
          }),
          ...(options.memory && { memory: options.memory }),
          onStart: () => undefined,
          onFinish: (_, done) => {
            finished = done
          },
        })
        if (result.outcome === 'interrupted') return stopped()
        if (result.outcome === 'memory') {
          await writeFile(log, `${memoryStopMessage}\n`, { flag: 'a', mode: 0o600 }).catch(
            () => undefined,
          )
          return { ...stopped(), outOfMemory: true, log }
        }
        const state: AutomationCheckState =
          finished?.state === 'timed-out'
            ? 'timed-out'
            : result.outcome === 'passed'
              ? 'passed'
              : 'failed'
        return {
          state,
          ...(finished?.exitCode !== undefined && { exitCode: finished.exitCode }),
          durationMs: Date.now() - started,
          ...(checkout.commit !== undefined && { commit: checkout.commit }),
          log,
          output: await readOutput(log),
          tail: await lastLines(log),
        }
      } catch (error) {
        if (signal.aborted) return stopped()
        const message = error instanceof Error ? error.message : String(error)
        return await failed(
          error instanceof SetupFailed ? message : `TED couldn’t prepare the checkout: ${message}`,
        )
      } finally {
        release()
        await checkouts.release(firingId)
        await pruneLogs(automationId).catch(() => undefined)
      }
    },
    async output(automationId, firingId) {
      const log = logOf(automationId, firingId)
      if (!(await lstat(log).catch(() => undefined))?.isFile()) {
        throw new RequestError(404, 'this Run’s output is gone')
      }
      return { text: await readOutput(log), log }
    },
    async saved(automationId, firingId) {
      const log = logOf(automationId, firingId)
      return {
        log,
        output: await readOutput(log).catch(() => ''),
        tail: await lastLines(log).catch(() => ''),
      }
    },
    async remove(automationId) {
      if (!safeId.test(automationId)) return
      await removeInside(logsRoot, automationId)
    },
  }
}
