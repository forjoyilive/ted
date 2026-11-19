import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { SandboxGroup } from '@ted/protocol'
import { markProcessRoot, type ProcessRoot } from '../process-roots.ts'
import { redactSecrets } from '../redact.ts'
import type { Sandbox, SandboxScope } from '../sandbox.ts'
import { type CommandResult, runWorktreeCommand } from './worktree.ts'

export interface CommandSandbox {
  sandbox: Sandbox
  scope: Omit<SandboxScope, 'tmp'>
  tmpRoot: string
}

export interface CommandLaunch {
  sandbox?: CommandSandbox
  release: () => void
}

export async function runTaskCommand(
  input: Parameters<typeof runWorktreeCommand>[0] & {
    label: string
    sandbox?: CommandSandbox
    prepareLaunch?: () => Promise<CommandLaunch>
    root?: ProcessRoot
    groups?: readonly SandboxGroup[]
  },
): Promise<CommandResult> {
  const { sandbox: givenSandbox, prepareLaunch, label, root, ...base } = input
  const groups = input.groups ?? input.command.groups ?? []
  let release = () => {}
  let unmark = () => {}
  let closeFds = async () => {}
  let tmp: string | undefined
  try {
    const prepared = await prepareLaunch?.()
    const sandbox = prepared ? prepared.sandbox : givenSandbox
    release = prepared?.release ?? (() => {})
    const command = {
      ...base,
      onSpawn: (pid: number | undefined) => {
        if (root !== undefined && pid !== undefined) unmark = markProcessRoot(pid, root)
        base.onSpawn?.(pid)
        release()
      },
    }
    if (sandbox === undefined) return await runWorktreeCommand(command)
    await mkdir(sandbox.tmpRoot, { recursive: true, mode: 0o700 })
    tmp = await mkdtemp(path.join(sandbox.tmpRoot, 'tmp-'))
    const wrapped = await sandbox.sandbox.wrap(input.shell ?? ['/bin/sh', '-c'], {
      ...sandbox.scope,
      tmp,
      groups,
    })
    closeFds = wrapped.close
    return await runWorktreeCommand({
      ...command,
      shell: wrapped.argv,
      fds: wrapped.fds,
      env: { ...command.env, ...wrapped.env },
      onSpawn: (pid) => {
        command.onSpawn(pid)
        void wrapped.close()
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const problem = redactSecrets(`Ted didn’t run ${label}: ${message}`)
    try {
      await mkdir(path.dirname(input.log), { recursive: true, mode: 0o700 })
      await writeFile(input.log, `${problem}\n`, { mode: 0o600 })
    } catch {
      console.error(problem)
    }
    return { outcome: 'failed', problem }
  } finally {
    unmark()
    release()
    await closeFds()
    if (tmp !== undefined) {
      await rm(tmp, { recursive: true, force: true }).catch((error: unknown) => {
        console.error(redactSecrets(`couldn’t remove command temp folder: ${String(error)}`))
      })
    }
  }
}
