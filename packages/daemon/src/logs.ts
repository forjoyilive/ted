import { closeSync, fstatSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import os from 'node:os'
import { format } from 'node:util'
import { tedPaths } from '@ted/protocol'
import { redactSecrets } from './redact.ts'

export interface LogLimits {
  maxBytes: number
  keep: number
}

export const tedLogLimits: LogLimits = { maxBytes: 20 * 1024 * 1024, keep: 7 }

export interface RollingLog {
  write(text: string): void
  close(): void
}

function shift(file: string, keep: number): void {
  rmSync(`${file}.${keep - 1}`, { force: true })
  for (let i = keep - 2; i >= 1; i--) {
    try {
      renameSync(`${file}.${i}`, `${file}.${i + 1}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (keep > 1) renameSync(file, `${file}.1`)
  else rmSync(file, { force: true })
}

export function openRollingLog(file: string, { maxBytes, keep }: LogLimits): RollingLog {
  let fd = openSync(file, 'a', 0o600)
  let size = fstatSync(fd).size

  return {
    write(text) {
      const bytes = Buffer.from(text)
      if (size > 0 && size + bytes.length > maxBytes) {
        closeSync(fd)
        shift(file, keep)
        fd = openSync(file, 'a', 0o600)
        size = 0
      }
      writeSync(fd, bytes)
      size += bytes.length
    },
    close() {
      closeSync(fd)
    },
  }
}

export async function rollLog(file: string, limits: LogLimits): Promise<void> {
  const size = await stat(file).then(
    (s) => s.size,
    () => 0,
  )
  if (size >= limits.maxBytes) shift(file, limits.keep)
}

async function tail(files: string[], maxBytes: number): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let left = maxBytes
  let found = false
  for (const file of files.toReversed()) {
    if (left <= 0) break
    const handle = await open(file, 'r').catch(() => undefined)
    if (!handle) continue
    found = true
    try {
      const { size } = await handle.stat()
      const length = Math.min(size, left)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, size - length)
      chunks.unshift(buffer)
      left -= length
    } finally {
      await handle.close()
    }
  }
  return found ? Buffer.concat(chunks).toString('utf8') : undefined
}

export async function crashReport(
  home: string,
  {
    version,
    crashes,
    maxBytesPerFile = 256 * 1024,
  }: { version: string; crashes: readonly string[]; maxBytesPerFile?: number },
): Promise<string> {
  const paths = tedPaths(home)
  const section = async (name: string, file: string) => {
    const text = await tail([`${file}.1`, file], maxBytesPerFile)
    return text === undefined
      ? `${name}: none`
      : `${name} (last ${maxBytesPerFile} bytes):\n${text}`
  }
  const text = [
    `TED ${version} crash report`,
    `${os.type()} ${os.release()} ${os.arch()}, Node ${process.versions.node}`,
    `Crashes: ${crashes.length === 0 ? 'none recorded' : crashes.join(', ')}`,
    '',
    await section('daemon.log', paths.daemonLog),
    '',
    await section('daemon-output.log', paths.daemonOutput),
  ].join('\n')
  return redactSecrets(text.replaceAll(home, '<TED home>').replaceAll(os.homedir(), '~'))
}

export function logConsoleTo(log: RollingLog): void {
  const line =
    (level: string) =>
    (...args: unknown[]) =>
      log.write(`${new Date().toISOString()} ${level} ${redactSecrets(format(...args))}\n`)
  console.log = line('info')
  console.info = line('info')
  console.warn = line('warn')
  console.error = line('error')
}
