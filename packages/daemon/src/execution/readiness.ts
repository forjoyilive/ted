import { execFile } from 'node:child_process'
import { statfs } from 'node:fs/promises'
import { cpus, loadavg } from 'node:os'
import { promisify } from 'node:util'
import { type ExecutionReadiness, tedVersion } from '@ted/protocol'
import { findBin } from '../cli-env.ts'
import { executionEnvironment } from '../command-env.ts'
import { redactSecrets } from '../redact.ts'
import { createSandbox } from '../sandbox.ts'

const run = promisify(execFile)
type AgentVersion = Pick<ExecutionReadiness['agents'][number], 'version' | 'versionReason'>

export function createExecutionReadiness(home: string, env: NodeJS.ProcessEnv) {
  const sandbox = createSandbox({ tedHome: home, env: () => env })
  let probe: Promise<string | undefined> | undefined
  const versions = new Map<string, { at: number; value: Promise<AgentVersion> }>()
  function version(executable: string): Promise<AgentVersion> {
    const known = versions.get(executable)
    if (known && Date.now() - known.at < 60_000) return known.value
    const value = (async (): Promise<AgentVersion> => {
      try {
        const result = await run(executable, ['--version'], {
          env: executionEnvironment(env),
          timeout: 3000,
          maxBuffer: 4096,
          encoding: 'utf8',
        })
        const reported = redactSecrets(result.stdout)
          .replace(/[^\x20-\x7e]/g, ' ')
          .trim()
        if (reported && reported.length <= 128)
          return {
            version: reported,
            versionReason: 'Reported by the local executable (--version)',
          }
      } catch {}
      return {
        version: null,
        versionReason: 'Local version check failed, timed out or returned no bounded version',
      }
    })()
    versions.set(executable, { at: Date.now(), value })
    return value
  }
  return async (capacity: number): Promise<ExecutionReadiness> => {
    probe ??= sandbox.problem()
    const reason = await probe
    const disk = await statfs(home)
    const agents = await Promise.all(
      ['claude', 'codex'].map(async (name) => {
        const executable = await findBin(name, env)
        return {
          name,
          detected: executable !== undefined,
          ...(executable
            ? await version(executable)
            : { version: null, versionReason: 'Executable not detected' }),
          modelAccess: 'unknown' as const,
          reason: 'Model access is unverified; Provider sign-ins stay on this Mac.',
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
