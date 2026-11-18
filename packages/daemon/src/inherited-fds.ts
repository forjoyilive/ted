import { closeSync, fstatSync, readdirSync, readFileSync } from 'node:fs'
import { tedEnv } from '@ted/protocol'

// On Linux, Node's spawn closes only close-on-exec descriptors, and Electron's main
// process holds many without the flag, so the daemon would inherit them.
const envName = 'TED_INHERITED_FDS'
const oCloexec = 0o2000000

export function inheritedFdsEnv(): Record<string, string> {
  if (process.platform !== 'linux') return {}
  const entries = readdirSync('/proc/self/fdinfo')
    .map(Number)
    .filter((fd) => fd > 2 && !isCloseOnExec(fd))
    .map((fd) => `${fd}:${identity(fd)}`)
    .filter((entry) => !entry.endsWith(':'))
  return entries.length > 0 ? { [envName]: entries.join(',') } : {}
}

// Matching identity guards against a listed descriptor that closed before the spawn
// and whose number the daemon's runtime then reused for one of its own.
export function closeInheritedFds(): void {
  const list = tedEnv(envName)
  delete process.env[envName]
  for (const entry of list?.split(',') ?? []) {
    const [fdText, ...id] = entry.split(':')
    const fd = Number(fdText)
    if (!Number.isInteger(fd) || fd <= 2 || identity(fd) !== id.join(':')) continue
    closeSync(fd)
  }
}

function identity(fd: number): string {
  try {
    const stat = fstatSync(fd, { bigint: true })
    return `${stat.dev}:${stat.ino}`
  } catch {
    return ''
  }
}

function isCloseOnExec(fd: number): boolean {
  try {
    const flags = /^flags:\s+([0-7]+)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))?.[1]
    return flags === undefined || (Number.parseInt(flags, 8) & oCloexec) !== 0
  } catch {
    return true
  }
}
