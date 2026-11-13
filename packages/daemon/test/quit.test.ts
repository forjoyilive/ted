import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runTokenEnv, tedPaths } from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  clearQuit,
  markQuit,
  quitMarked,
  stopTedProcesses,
  TedQuitError,
  tedQuitExitCode,
  withDaemon,
} from '../src/launch.ts'
import { makeTempHome } from './helpers.ts'

const mainPath = fileURLToPath(new URL('../src/main.ts', import.meta.url))
const lockUrl = pathToFileURL(fileURLToPath(new URL('../src/lock.ts', import.meta.url))).href

let home: string
let cleanup: () => Promise<void>
const children: ChildProcess[] = []
const pids: number[] = []

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
})

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  for (const pid of pids.splice(0)) if (alive(pid)) process.kill(pid, 'SIGKILL')
  await cleanup()
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Like a Run host: a process-group leader holding the lock, optionally with an agent child
// that ignores SIGTERM.
async function holdLock(
  file: string,
  { ignoreTerm = false, stubbornChild = false } = {},
): Promise<{ child: ChildProcess; agent: number }> {
  await mkdir(path.dirname(file), { recursive: true })
  const code = `import { spawn } from 'node:child_process'
import { tryLock } from ${JSON.stringify(lockUrl)}
globalThis.held = tryLock(${JSON.stringify(file)})
if (!globalThis.held) process.exit(2)
${ignoreTerm ? "process.on('SIGTERM', () => {})" : ''}
const agent = ${stubbornChild} ? spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' }).pid : 0
setInterval(() => {}, 1000)
console.log(agent)`
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: true,
  })
  children.push(child)
  const [line] = (await once(child.stdout as NodeJS.ReadableStream, 'data')) as [Buffer]
  const agent = Number(String(line).trim())
  if (agent > 0) pids.push(agent)
  return { child, agent }
}

const exitOf = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve(child.signalCode)
    : once(child, 'exit').then(([, signal]) => signal as NodeJS.Signals | null)

test('Quit’s forced stop ends the daemon, Run hosts and their agents, and follows no links', async () => {
  const paths = tedPaths(home)
  const polite = await holdLock(path.join(paths.runs, 'run-a', 'host.lock'), {
    stubbornChild: true,
  })
  const stubborn = await holdLock(path.join(paths.runs, 'run-b', 'host.lock'), {
    ignoreTerm: true,
  })
  const daemon = await holdLock(paths.daemonLock)
  const outsideFile = path.join(home, 'outside', 'host.lock')
  const outsider = await holdLock(outsideFile)
  await mkdir(path.join(paths.runs, 'run-c'), { recursive: true })
  await symlink(outsideFile, path.join(paths.runs, 'run-c', 'host.lock'))
  await symlink(path.dirname(outsideFile), path.join(paths.runs, 'run-d'))
  const exits = [polite, stubborn, daemon].map(({ child }) => exitOf(child))

  await stopTedProcesses(home, { graceMs: 500 })

  expect(await Promise.all(exits)).toEqual(['SIGTERM', 'SIGKILL', 'SIGTERM'])
  for (let i = 0; i < 50 && alive(polite.agent); i++) await sleep(20)
  expect(alive(polite.agent)).toBe(false)
  expect(outsider.child.exitCode).toBeNull()
  expect(outsider.child.signalCode).toBeNull()
})

test('after Quit no ted command starts TED until the app clears the mark', async () => {
  await markQuit(home)
  const saved = process.env[runTokenEnv]
  try {
    process.env[runTokenEnv] = 'run-capability'
    await expect(withDaemon(home, async () => 'reached')).rejects.toBeInstanceOf(TedQuitError)
    delete process.env[runTokenEnv]
    await expect(withDaemon(home, async () => 'reached')).rejects.toBeInstanceOf(TedQuitError)
  } finally {
    if (saved === undefined) delete process.env[runTokenEnv]
    else process.env[runTokenEnv] = saved
  }

  const child = spawn(process.execPath, [mainPath], {
    env: { ...process.env, TED_HOME: home },
    stdio: 'ignore',
  })
  children.push(child)
  const [code] = await once(child, 'exit')
  expect(code).toBe(tedQuitExitCode)
  expect(await quitMarked(home)).toBe(true)

  await clearQuit(home)
  expect(await quitMarked(home)).toBe(false)
})

test('a quit mark that isn’t a plain file is replaced without following it', async () => {
  const target = path.join(home, 'target.txt')
  await writeFile(target, 'keep')
  await symlink(target, tedPaths(home).quitMark)
  expect(await quitMarked(home)).toBe(false)

  await markQuit(home)

  expect(await quitMarked(home)).toBe(true)
  expect(await readFile(target, 'utf8')).toBe('keep')
})
