import { execFile } from 'node:child_process'
import { hostname } from 'node:os'
import { promisify } from 'node:util'

const run = promisify(execFile)

export async function computerName(): Promise<string> {
  if (process.platform === 'darwin') {
    const name = await run('/usr/sbin/scutil', ['--get', 'ComputerName'], { timeout: 5_000 })
      .then(({ stdout }) => stdout.trim())
      .catch(() => '')
    if (name) return name
  }
  return hostname()
}
