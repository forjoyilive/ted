import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { findBin } from './cli-env.ts'
import { RequestError } from './errors.ts'
import { shellQuote } from './node-entry.ts'

export type OpenTerminal = (command: string, env: NodeJS.ProcessEnv) => Promise<void>

export function terminalScript(
  command: string,
  env: NodeJS.ProcessEnv,
  { removeSelf = false }: { removeSelf?: boolean } = {},
): string {
  return [
    '#!/bin/sh',
    `export PATH=${shellQuote(env.PATH ?? '/usr/bin:/bin')}`,
    ...(removeSelf ? ['rm -f -- "$0"'] : []),
    `printf '%s\\n\\n' ${shellQuote(`$ ${command}`)}`,
    command,
    `printf '\\n%s\\n' ${shellQuote('Done. You can close this window and go back to Ted.')}`,
    '',
  ].join('\n')
}

export function createTerminalOpener({ tmpDir }: { tmpDir: string }): OpenTerminal {
  return async (command, env) => {
    if (process.platform === 'darwin') {
      await mkdir(tmpDir, { recursive: true, mode: 0o700 })
      const file = path.join(tmpDir, `fix-${randomBytes(8).toString('hex')}.command`)
      await writeFile(file, terminalScript(command, env, { removeSelf: true }), {
        mode: 0o700,
        flag: 'wx',
      })
      await chmod(file, 0o700)
      await new Promise<void>((resolve, reject) =>
        execFile('open', ['-a', 'Terminal', file], (error) => (error ? reject(error) : resolve())),
      )
      return
    }
    const script = `${terminalScript(command, env)}printf '%s' 'Press Return to close.'; read -r _\n`
    for (const name of [
      env.TERMINAL,
      'x-terminal-emulator',
      'gnome-terminal',
      'konsole',
      'xterm',
    ]) {
      if (!name) continue
      const bin = path.isAbsolute(name) ? name : await findBin(name, env)
      if (!bin) continue
      const flag = path.basename(bin) === 'gnome-terminal' ? '--' : '-e'
      const child = spawn(bin, [flag, 'sh', '-c', script, 'ted-fix'], {
        env,
        detached: true,
        stdio: 'ignore',
      })
      child.on('error', () => {})
      child.unref()
      return
    }
    throw new RequestError(409, 'Ted couldn’t find a terminal app. Copy the command instead.')
  }
}
