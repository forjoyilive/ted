import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, readlink, rm } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { DaemonClient, readDaemonInfo, tedEnv, tedPaths, tedVersion } from '@ted/protocol'
import { isInteger, isObject, type Json, type JsonObject, parseJson } from '@ted/protocol/parse'
import { clearQuit, markQuit, stopTedProcesses, withDaemon } from '../launch.ts'
import { holdsLock, lockHolders } from '../lock.ts'
import { makeDemoOrigins, prepareDemoBinaries } from './fixtures.ts'
import {
  checkDemoHome,
  type DemoManifest,
  demoVersion,
  markDemo,
  withDemoEnvironment,
} from './home.ts'
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
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
    throw error
  }
}

function recordedPid(value: Json | undefined, what: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (!isInteger(value) || value <= 1) throw new Error(`Unexpected demo ${what} pid.`)
  return value
}

async function plainFile(file: string, what: string): Promise<string | undefined> {
  const stat = await lstat(file).catch(() => undefined)
  if (!stat) return undefined
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unexpected demo ${what}.`)
  return readFile(file, 'utf8')
}

async function plainFolders(folder: string, what: string, name?: RegExp): Promise<string[]> {
  const names = await readdir(folder).catch(() => [])
  for (const entry of names) {
    if (name && !name.test(entry)) throw new Error(`Unexpected demo ${what} name.`)
    const stat = await lstat(path.join(folder, entry))
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unexpected demo ${what}.`)
  }
  return names
}

async function subfolders(folder: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) found.push(path.join(folder, entry.name))
  }
  return found
}

function startRecords(text: string | undefined): JsonObject[] {
  return (text ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => parseJson(line))
    .filter((entry): entry is JsonObject => isObject(entry) && entry.t === 'start')
}

async function demoPids(home: string): Promise<{ pids: Set<number>; runs: number }> {
  const pids = new Set<number>()
  const daemon = await readDaemonInfo(home)
  if (daemon && (await holdsLock(tedPaths(home).daemonLock, daemon.pid))) pids.add(daemon.pid)
  const runsFolder = path.join(home, 'runs')
  const runs = await plainFolders(runsFolder, 'Run', /^[a-f0-9-]{36}$/)
  for (const run of runs) {
    const log = await plainFile(path.join(runsFolder, run, 'host.log'), 'host log')
    for (const entry of startRecords(log)) {
      for (const pid of [entry.hostPid, entry.agentPid]) {
        const valid = recordedPid(pid, 'host')
        if (valid !== undefined) pids.add(valid)
      }
    }
  }
  const apps = path.join(home, 'apps')
  for (const task of await subfolders(apps)) {
    for (const repo of await subfolders(task)) {
      for (const app of await subfolders(repo)) {
        const log = await plainFile(path.join(app, 'host.jsonl'), 'App log')
        for (const entry of startRecords(log)) {
          for (const pid of [entry.hostPid, entry.pid]) {
            const valid = recordedPid(pid, 'App')
            if (valid !== undefined) pids.add(valid)
          }
        }
      }
    }
  }
  pids.delete(process.pid)
  return { pids, runs: runs.length }
}

async function demoAppRunning(home: string): Promise<boolean> {
  const target = await readlink(path.join(home, 'electron', 'SingletonLock')).catch(() => '')
  const pid = Number(target.slice(target.lastIndexOf('-') + 1))
  return Number.isInteger(pid) && pid > 1 && processRunning(pid)
}

async function demoLocks(home: string): Promise<{ all: string[]; apps: string[] }> {
  const paths = tedPaths(home)
  const isPlainFile = async (file: string) => {
    const stat = await lstat(file).catch(() => undefined)
    return stat?.isFile() === true
  }
  const all: string[] = []
  const apps: string[] = []
  if (await isPlainFile(paths.daemonLock)) all.push(paths.daemonLock)
  for (const run of await subfolders(paths.runs)) {
    const lock = path.join(run, 'host.lock')
    if (await isPlainFile(lock)) all.push(lock)
  }
  for (const task of await subfolders(paths.apps)) {
    for (const repo of await subfolders(task)) {
      for (const app of await subfolders(repo)) {
        const lock = path.join(app, 'host.lock')
        if (await isPlainFile(lock)) apps.push(lock)
      }
    }
  }
  return { all: [...all, ...apps], apps }
}

async function demoLockHolders(home: string): Promise<number[]> {
  const { all } = await demoLocks(home)
  return (await lockHolders(...all)).filter((pid) => pid > 1 && pid !== process.pid)
}

export class DemoAppRunningError extends Error {
  constructor() {
    super('Quit the demo app first.')
  }
}

export async function stopDemo(home: string): Promise<void> {
  const known = await checkDemoHome(home)
  if (!known) throw new Error(`There is no demo in ${home}.`)
  if (await demoAppRunning(home)) throw new DemoAppRunningError()
  const before = await demoPids(home)
  if ((await demoLockHolders(home)).length === 0) return markQuit(home)
  try {
    await clearQuit(home)
    await prepareDemoBinaries(home)
    await withDaemon(
      home,
      async (client) => {
        try {
          for (const task of await client.listTasks()) {
            for (const app of await client.listApps(task.id)) {
              await client.stopApp(task.id, { repo: app.repo, name: app.name })
            }
          }
        } finally {
          await markQuit(home)
          await client.shutdown()
        }
      },
      { appToken: randomBytes(32).toString('hex') },
    )
    await until(async () => !(await readDaemonInfo(home)), 'the demo daemon to stop')
    await until(
      async () => {
        const { pids } = await demoPids(home)
        return [...before.pids, ...pids].every((pid) => !processRunning(pid))
      },
      'demo processes to exit',
      10_000,
    ).catch(() => undefined)
  } finally {
    await markQuit(home)
    await stopTedProcesses(home, { extraLocks: (await demoLocks(home)).apps })
    await until(
      async () => (await demoLockHolders(home)).length === 0,
      'demo processes to exit',
      5_000,
    )
    if (before.runs > 0 && known.complete) await markDemo(home, { ...known, complete: false })
  }
}

export function stopDemoFromCli(home: string): Promise<void> {
  return withDemoEnvironment(home, () => stopDemo(home))
}

export async function prepareDemo(home: string, reset = false): Promise<DemoManifest> {
  const known = await checkDemoHome(home)
  if (reset && known) {
    await stopDemo(home)
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
    maxRunningDevices: 1,
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

export function seedDemoFromCli(home: string, reset = false): Promise<DemoManifest> {
  return withDemoEnvironment(home, () => seedInDemoEnvironment(home, reset))
}

async function seedInDemoEnvironment(home: string, reset: boolean): Promise<DemoManifest> {
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
      await markQuit(home)
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
