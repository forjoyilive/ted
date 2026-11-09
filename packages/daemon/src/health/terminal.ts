import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { findExecutable } from './cli.ts'

export interface TerminalLaunch {
  file: string
  args: string[]
}

export const linuxTerminals = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']

export function scriptText(command: string): string {
  return [
    '#!/bin/sh',
    `printf '%s\\n\\n' ${quote(`TED opened this window to run: ${command}`)}`,
    command,
    `printf '\\n%s\\n' ${quote('You can close this window. TED notices the change by itself.')}`,
    '',
  ].join('\n')
}

export function terminalLaunch(options: {
  platform: NodeJS.Platform
  script: string
  env: NodeJS.ProcessEnv
}): TerminalLaunch | undefined {
  const { platform, script, env } = options
  if (platform === 'darwin') return { file: '/usr/bin/open', args: ['-a', 'Terminal', script] }
  const keepOpen = `sh ${quote(script)}; printf '%s' ${quote('Press Enter to close. ')}; read _`
  const chosen = env.TERMINAL?.trim()
  const candidates = [...(chosen ? [chosen] : []), ...linuxTerminals]
  for (const name of candidates) {
    const file = findExecutable(name, env)
    if (!file) continue
    const args =
      path.basename(file) === 'gnome-terminal'
        ? ['--', 'sh', '-c', keepOpen]
        : ['-e', 'sh', '-c', keepOpen]
    return { file, args }
  }
  return undefined
}

export async function openInTerminal(options: {
  command: string
  scriptsDir: string
  env: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}): Promise<void> {
  const platform = options.platform ?? process.platform
  await mkdir(options.scriptsDir, { recursive: true, mode: 0o700 })
  await removeOldScripts(options.scriptsDir)
  const script = path.join(options.scriptsDir, `ted-fix-${randomBytes(8).toString('hex')}.command`)
  await writeFile(script, scriptText(options.command), { mode: 0o700, flag: 'wx' })
  const launch = terminalLaunch({ platform, script, env: options.env })
  if (!launch) {
    throw new Error(
      'TED couldn’t find a terminal app. Set $TERMINAL, or copy the command and run it yourself.',
    )
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(launch.file, launch.args, {
      detached: true,
      stdio: 'ignore',
      env: options.env,
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

const scriptLifetimeMs = 60 * 60 * 1000

async function removeOldScripts(dir: string): Promise<void> {
  for (const name of await readdir(dir).catch(() => [])) {
    if (!name.startsWith('ted-fix-')) continue
    const file = path.join(dir, name)
    const info = await stat(file).catch(() => undefined)
    if (info && Date.now() - info.mtimeMs > scriptLifetimeMs) await rm(file, { force: true })
  }
}

function quote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`
}
