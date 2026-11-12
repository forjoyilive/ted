import { constants } from 'node:fs'
import { access, statfs } from 'node:fs/promises'
import { cpus, loadavg } from 'node:os'
import path from 'node:path'
import { type ExecutionReadiness, tedVersion } from '@ted/protocol'
import { createSandbox } from '../sandbox.ts'

export function createExecutionReadiness(home: string, env: NodeJS.ProcessEnv) {
  const sandbox = createSandbox({ tedHome: home, env: () => env })
  let probe: Promise<string | undefined> | undefined
  return async (capacity: number): Promise<ExecutionReadiness> => {
    probe ??= sandbox.problem()
    const reason = await probe
    const disk = await statfs(home)
    const agents = await Promise.all(
      ['claude', 'codex'].map(async (name) => {
        let detected = false
        for (const folder of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
          if (
            await access(path.join(folder, name), constants.X_OK).then(
              () => true,
              () => false,
            )
          ) {
            detected = true
            break
          }
        }
        return {
          name,
          detected,
          modelAccess: 'unknown' as const,
          reason: 'Model access is unverified; agent sign-ins stay on this Mac.',
        }
      }),
    )
    return {
      observedAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      version: tedVersion,
      agents,
      sandbox: {
        available: reason === undefined,
        reason:
          reason === undefined
            ? 'Native sandbox probe passed'
            : 'Native sandbox unavailable; inspect this Mac’s sandbox installation and permissions.',
      },
      freeBytes: Number(disk.bavail) * Number(disk.bsize),
      loadPerCore: Math.max(0, (loadavg()[0] ?? 0) / Math.max(1, cpus().length)),
      capacity,
    }
  }
}
