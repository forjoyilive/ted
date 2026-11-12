import { createHash } from 'node:crypto'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const evidenceFiles = [
  'ted-test-report-electron.json',
  'ted-test-report-node.json',
  'ted-test-retries-electron.json',
  'ted-test-retries-node.json',
  'ted-test-times.json',
  'ted-test-failures.json',
]

function digest(file: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return undefined
  }
}

export function measureCheck(folder: string | undefined, cache: string) {
  if (!folder) return undefined
  const startedAt = new Date().toISOString()
  const origin = performance.now()
  const before = new Map(evidenceFiles.map((name) => [name, digest(path.join(cache, name))]))
  const phases: Record<string, { startMs: number; endMs?: number }> = {}
  return {
    start(name: string) {
      phases[name] = { startMs: performance.now() - origin }
    },
    end(name: string) {
      const phase = phases[name]
      if (phase) phase.endMs = performance.now() - origin
      if (name === 'lock') {
        for (const file of evidenceFiles) before.set(file, digest(path.join(cache, file)))
        for (const project of ['electron', 'node']) {
          before.delete(`ted-test-report-${project}.json`)
          before.delete(`ted-test-retries-${project}.json`)
        }
      }
    },
    finish(ok: boolean) {
      const totalMs = performance.now() - origin
      const artifacts: Record<string, string> = {}
      for (const name of evidenceFiles) {
        const file = path.join(cache, name)
        const hash = digest(file)
        if (phases['Test node'] && hash && hash !== before.get(name)) {
          copyFileSync(file, path.join(folder, name))
          artifacts[name] = hash
        }
      }
      const lock = phases.lock
      const lockWaitMs = lock?.endMs === undefined ? null : lock.endMs - lock.startMs
      const projects = [phases['Test electron'], phases['Test node']]
      const complete = projects.every((phase) => phase?.endMs !== undefined)
      const testProcessEnvelopeMs = complete
        ? Math.max(...projects.map((phase) => phase?.endMs ?? 0)) -
          Math.min(...projects.map((phase) => phase?.startMs ?? 0))
        : null
      writeFileSync(
        path.join(folder, 'check-measurement.json'),
        `${JSON.stringify(
          {
            startedAt,
            ok,
            totalMs,
            lockWaitMs,
            workMs: lockWaitMs === null ? null : totalMs - lockWaitMs,
            testProcessEnvelopeMs,
            phases,
            artifacts,
          },
          null,
          2,
        )}\n`,
        { flag: 'wx' },
      )
    },
  }
}

export type CheckMeasurement = ReturnType<typeof measureCheck>
