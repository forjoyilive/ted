import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { redactSecrets } from '../redact.ts'
import { type Sandbox, type SandboxScope, SandboxUnavailable } from '../sandbox.ts'
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
  await mkdir(sandbox.tmpRoot, { recursive: true, mode: 0o700 })
  const tmp = await mkdtemp(path.join(sandbox.tmpRoot, 'tmp-'))
  try {
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
    if (!(error instanceof SandboxUnavailable)) throw error
    await mkdir(path.dirname(input.log), { recursive: true, mode: 0o700 })
    await writeFile(input.log, redactSecrets(`TED didn’t run ${label}: ${error.message}\n`), {
      mode: 0o600,
    })
    return { outcome: 'failed' }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}
