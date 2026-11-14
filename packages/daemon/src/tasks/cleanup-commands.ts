import type { CleanupCommandResult } from '../store/index.ts'
import type { CleanupCommandStep } from '../workflow/check.ts'
import { defaultCheckTimeout, lastLines } from './checks.ts'
import { type CommandLaunch, runTaskCommand } from './command.ts'
import { durationMs } from './worktree.ts'

export const cleanupOutputLines = 20

export async function runCleanupCommands(input: {
  steps: readonly CleanupCommandStep[]
  cwd: string
  env: NodeJS.ProcessEnv
  shell: [string, ...string[]]
  logFor: (position: number) => string
  prepareLaunch: () => Promise<CommandLaunch>
  lowPriority: boolean
  signal?: AbortSignal
  record: (result: CleanupCommandResult) => void
}): Promise<{ outcome: 'done' | 'interrupted'; results: CleanupCommandResult[] }> {
  const results: CleanupCommandResult[] = []
  for (const [position, step] of input.steps.entries()) {
    if (input.signal?.aborted) return { outcome: 'interrupted', results }
    const timeout = step.timeout ?? defaultCheckTimeout
    const log = input.logFor(position)
    const started = Date.now()
    const ran = await runTaskCommand({
      label: `the Cleanup command “${step.name}”`,
      command: { run: step.command, timeoutMs: durationMs(timeout) },
      cwd: input.cwd,
      env: input.env,
      log,
      shell: input.shell,
      lowPriority: input.lowPriority,
      ...(input.signal !== undefined && { signal: input.signal }),
      prepareLaunch: input.prepareLaunch,
    })
    if (ran.outcome === 'interrupted') return { outcome: 'interrupted', results }
    const result: CleanupCommandResult = {
      step: step.name,
      state: ran.outcome,
      ...(ran.exitCode !== undefined && { exitCode: ran.exitCode }),
      timeout,
      durationMs: Date.now() - started,
      output: await lastLines(log, cleanupOutputLines).catch(() => ''),
    }
    input.record(result)
    results.push(result)
  }
  return { outcome: 'done', results }
}

export function cleanupCommandsText(
  ran: readonly CleanupCommandResult[],
  instructionsLeft: number,
): string {
  const failed = ran.filter((r) => r.state !== 'passed')
  const lines = ran.map((r) => {
    const head = `- “${r.step}”: ${r.state === 'passed' ? 'passed' : r.state === 'timed-out' ? `timed out after ${r.timeout}` : r.exitCode === undefined ? 'failed' : `failed with exit code ${r.exitCode}`}`
    return r.state === 'passed' || r.output === ''
      ? head
      : `${head}. Its last lines:\n\n\`\`\`\n${r.output}\n\`\`\``
  })
  return [
    '# Cleanup commands TED ran',
    lines.join('\n'),
    failed.length > 0
      ? 'A failed command counts as a failed Cleanup step, and TED has already recorded it. Find out why it failed: you may run it again by hand in the worktree to see more. Don’t report it with `ted cleanup report`. Say what you found and what the user should change in your note.'
      : '',
    instructionsLeft > 0
      ? 'Now do the instruction steps.'
      : 'There are no instruction steps left. Post your note, then run `ted outcome advance`.',
  ]
    .filter((part) => part !== '')
    .join('\n\n')
}
