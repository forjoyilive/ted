import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { redactSecrets } from '../redact.ts'
import type { Sandbox, SandboxScope } from '../sandbox.ts'
import { type CommandResult, runWorktreeCommand } from './worktree.ts'

export interface CommandSandbox {
  sandbox: Sandbox
  scope: Omit<SandboxScope, 'tmp'>
  tmpRoot: string
}

export async function runTaskCommand(
  input: Parameters<typeof runWorktreeCommand>[0] & {
    label: string
    sandbox?: CommandSandbox
  },
): Promise<CommandResult> {
  const { sandbox, label, ...command } = input
  if (sandbox === undefined) return runWorktreeCommand(command)
  let tmp: string | undefined
  try {
    await mkdir(sandbox.tmpRoot, { recursive: true, mode: 0o700 })
    tmp = await mkdtemp(path.join(sandbox.tmpRoot, 'tmp-'))
    const wrapped = await sandbox.sandbox.wrap(input.shell ?? ['/bin/sh', '-c'], {
      ...sandbox.scope,
      tmp,
    })
    return await runWorktreeCommand({
      ...command,
      shell: wrapped.argv,
      env: { ...command.env, ...wrapped.env },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const problem = redactSecrets(`TED didn’t run ${label}: ${message}`)
    try {
      await mkdir(path.dirname(input.log), { recursive: true, mode: 0o700 })
      await writeFile(input.log, `${problem}\n`, { mode: 0o600 })
    } catch {
      console.error(problem)
    }
    return { outcome: 'failed', problem }
  } finally {
    if (tmp !== undefined) {
      await rm(tmp, { recursive: true, force: true }).catch((error: unknown) => {
        console.error(redactSecrets(`couldn’t remove command temp folder: ${String(error)}`))
      })
    }
  }
}
