import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { DaemonClient, readDaemonInfo, tedEnv, tedVersion } from '@ted/protocol'
import { withDaemon } from '../launch.ts'
import { makeDemoOrigins, prepareDemoBinaries } from './fixtures.ts'
import { checkDemoHome, type DemoManifest, demoVersion, markDemo } from './home.ts'
import { seedScenarios, verifyDemo } from './scenarios.ts'

export { checkDemoHome, demoEnvironment, demoHome } from './home.ts'
export { verifyDemo } from './scenarios.ts'

export async function until<T>(
  read: () => Promise<T | undefined | false>,
  what: string,
  timeout = 20_000,
): Promise<T> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await read()
    if (value !== undefined && value !== false) return value
    await sleep(25)
  }
  throw new Error(`Demo timed out waiting for ${what}.`)
}

function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

export async function prepareDemo(home: string, reset = false): Promise<DemoManifest> {
  const known = await checkDemoHome(home)
  if (reset && known) {
    const daemon = await readDaemonInfo(home)
    if (daemon && (!Number.isInteger(daemon.pid) || daemon.pid <= 1))
      throw new Error('Unexpected demo daemon pid.')
    if (daemon && processRunning(daemon.pid))
      throw new Error('Quit the demo app before resetting its data.')
    const runs = await readdir(path.join(home, 'runs')).catch(() => [])
    const pids = new Set<number>()
    for (const run of runs) {
      if (!/^[a-f0-9-]{36}$/.test(run)) throw new Error('Unexpected demo Run name.')
      const dir = path.join(home, 'runs', run)
      if (!(await lstat(dir)).isDirectory()) throw new Error('Unexpected demo Run folder.')
      const log = path.join(dir, 'host.log')
      const stat = await lstat(log).catch(() => undefined)
      if (!stat) continue
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unexpected demo host log.')
      const lines = (await readFile(log, 'utf8')).trim().split('\n')
      for (const line of lines.filter(Boolean)) {
        const entry = JSON.parse(line) as { hostPid?: number | null; agentPid?: number | null }
        for (const pid of [entry.hostPid, entry.agentPid]) {
          if (pid === undefined || pid === null) continue
          if (!Number.isInteger(pid) || pid <= 1) throw new Error('Unexpected demo host pid.')
          pids.add(pid)
        }
      }
    }
    const appFolders = await readdir(path.join(home, 'apps')).catch(() => [])
    if (runs.length > 0 || appFolders.length > 0) {
      await prepareDemoBinaries(home)
      await withDaemon(
        home,
        async (client) => {
          const current = await readDaemonInfo(home)
          if (!current || !Number.isInteger(current.pid) || current.pid <= 1)
            throw new Error('Unexpected demo daemon pid.')
          pids.add(current.pid)
          try {
            for (const task of await client.listTasks()) {
              for (const app of await client.listApps(task.id)) {
                await client.stopApp(task.id, { repo: app.repo, name: app.name })
              }
            }
          } finally {
            await client.shutdown()
          }
        },
        { appToken: randomBytes(32).toString('hex') },
      )
      await until(async () => !(await readDaemonInfo(home)), 'demo shutdown before reset')
    }
    await until(
      async () => {
        for (const pid of pids) {
          if (processRunning(pid)) return false
        }
        return true
      },
      'demo processes to exit before reset',
      10_000,
    )
    await checkDemoHome(home)
    await rm(home, { recursive: true, maxRetries: 10, retryDelay: 100 })
  }
  if (known && !reset) {
    if (known.version !== demoVersion || !known.complete)
      throw new Error('This demo is incomplete or outdated. Run ted dev seed --reset.')
    await prepareDemoBinaries(home)
    return known
  }
  await mkdir(home, { recursive: true, mode: 0o700 })
  const pending: DemoManifest = { version: demoVersion, complete: false }
  await markDemo(home, pending)
  await makeDemoOrigins(home)
  await prepareDemoBinaries(home)
  return pending
}

export async function seedDemo(home: string, client: DaemonClient): Promise<DemoManifest> {
  const known = await checkDemoHome(home)
  if (!known || known.version !== demoVersion)
    throw new Error('Prepare the demo home before seeding.')
  if (known.complete) return known
  const start = Date.now()
  await client.updateSettings({
    firstLaunchDone: true,
    reportingAsked: true,
    maxWorkingRuns: 99,
    maxBootedSimulators: 1,
    stayAwake: false,
    startAtLogin: false,
    notifyInboxItems: false,
    notifyProblems: false,
    restartIdleRuns: false,
    linearSync: false,
  })
  const tasks = await seedScenarios(home, client)
  await verifyDemo(client)
  const manifest = { version: demoVersion, complete: true, tasks, elapsedMs: Date.now() - start }
  await markDemo(home, manifest)
  return manifest
}

export async function seedDemoFromCli(home: string, reset = false): Promise<DemoManifest> {
  const prepared = await prepareDemo(home, reset)
  if (prepared.complete) return prepared
  const { startDaemon } = await import('../daemon.ts')
  const { DaemonAlreadyRunningError } = await import('../lock.ts')
  const { startStubLinear } = await import('../../test/fixtures/stub-linear.ts')
  const linear = await startStubLinear()
  const claudeBin = tedEnv('TED_CLAUDE_BIN')
  const codexBin = tedEnv('TED_CODEX_BIN')
  const ghBin = tedEnv('TED_GH_BIN')
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined
  try {
    daemon = await until(
      async () => {
        try {
          return await startDaemon({
            home,
            version: tedVersion,
            checkAgentsOnStart: true,
            ...(claudeBin && { claudeBin }),
            ...(codexBin && { codexBin }),
            integrations: {
              checkOnStart: true,
              loginShell: false,
              ...(ghBin && { ghBin }),
            },
            mergePollMs: 500,
            simulators: { supported: true },
            linear: { apiUrl: linear.url },
            nudgeAfterMs: Number(tedEnv('TED_NUDGE_AFTER_MS')),
            stallAfterMs: Number(tedEnv('TED_STALL_AFTER_MS')),
          })
        } catch (error) {
          if (error instanceof DaemonAlreadyRunningError) return false
          throw error
        }
      },
      'demo daemon lock',
      120_000,
    )
    const info = await readDaemonInfo(home)
    if (!info) throw new Error('The demo daemon did not publish its connection.')
    const client = new DaemonClient(info, '', { appKey: daemon.appToken })
    let complete = false
    try {
      const manifest = await seedDemo(home, client)
      complete = true
      return manifest
    } finally {
      await client.shutdown({ keepRuns: complete })
    }
  } finally {
    try {
      await daemon?.stop()
    } finally {
      await linear.close()
    }
  }
}
