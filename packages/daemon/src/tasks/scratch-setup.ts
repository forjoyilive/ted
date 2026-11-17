import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { Banners } from '../banners.ts'
import { worktreeCommandEnv } from '../command-env.ts'
import { redactSecrets } from '../redact.ts'
import type { Sandbox, SandboxScope } from '../sandbox.ts'
import { runTaskCommand } from './command.ts'
import { outputTail, type WorktreeCommand } from './worktree.ts'

export class SetupFailed extends Error {}

export interface ScratchRepo {
  name: string
  worktree: string
  env: Record<string, string>
  setup?: WorktreeCommand
}

export async function sandboxProblem(
  sandbox: Sandbox,
  banners: Banners,
  factoryId: string,
): Promise<string | undefined> {
  const problem = await sandbox.problem()
  if (problem !== undefined) {
    banners.raise({
      problem: 'sandbox-unavailable',
      factoryId,
      severity: 'stops-work',
      text: problem,
    })
  }
  return problem
}

export async function runScratchSetup(input: {
  repos: readonly ScratchRepo[]
  factoryId: string
  sandbox: Sandbox
  banners: Banners
  scope: Omit<SandboxScope, 'tmp'>
  tmpRoot: string
  logDir: string
  env: NodeJS.ProcessEnv
  lowPriority: boolean
  signal?: AbortSignal
}): Promise<void> {
  for (const repo of input.repos) {
    if (!repo.setup) continue
    const problem = await sandboxProblem(input.sandbox, input.banners, input.factoryId)
    if (problem !== undefined) throw new SetupFailed(problem)
    await mkdir(input.scope.cache, { recursive: true, mode: 0o700 })
    const log = path.join(input.logDir, `setup-${repo.name}.log`)
    const result = await runTaskCommand({
      label: 'setup',
      command: repo.setup,
      cwd: repo.worktree,
      env: worktreeCommandEnv(repo.env, {}, input.env),
      log,
      lowPriority: input.lowPriority,
      ...(input.signal !== undefined && { signal: input.signal }),
      sandbox: { sandbox: input.sandbox, scope: input.scope, tmpRoot: input.tmpRoot },
    })
    if (result.outcome === 'interrupted') throw new SetupFailed('The setup was stopped.')
    if (result.outcome !== 'passed') {
      const tail = await outputTail(log).catch(() => '')
      const how =
        result.outcome === 'timed-out'
          ? 'timed out'
          : result.exitCode !== undefined
            ? `failed with exit code ${result.exitCode}`
            : 'failed'
      throw new SetupFailed(
        redactSecrets(
          `The setup command for ${repo.name} ${how}${tail.trim() === '' ? '' : `:\n${tail.trim()}`}`,
        ),
      )
    }
  }
}
