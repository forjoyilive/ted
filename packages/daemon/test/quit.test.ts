import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runTokenEnv, tedPaths } from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
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

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
})

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  await cleanup()
})

async function holdLock(file: string, { ignoreTerm }: { ignoreTerm: boolean }) {
  await mkdir(path.dirname(file), { recursive: true })
  const code = `import { tryLock } from ${JSON.stringify(lockUrl)}
globalThis.held = tryLock(${JSON.stringify(file)})
if (!globalThis.held) process.exit(2)
${ignoreTerm ? "process.on('SIGTERM', () => {})" : ''}
setInterval(() => {}, 1000)
console.log('ready')`
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  const started = await Promise.race([
    once(child.stdout as NodeJS.ReadableStream, 'data').then(() => 'ready'),
    once(child, 'exit').then(([code]) => `exited ${code}`),
  ])
  expect(started).toBe('ready')
  return child
}

const exitOf = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve(child.signalCode)
    : once(child, 'exit').then(([, signal]) => signal as NodeJS.Signals | null)

test('Quit’s forced stop ends Run hosts and the daemon, killing any that ignore SIGTERM', async () => {
  const paths = tedPaths(home)
  const polite = await holdLock(path.join(paths.runs, 'run-a', 'host.lock'), { ignoreTerm: false })
  const stubborn = await holdLock(path.join(paths.runs, 'run-b', 'host.lock'), {
    ignoreTerm: true,
  })
  const daemon = await holdLock(paths.daemonLock, { ignoreTerm: false })
  const politeExit = exitOf(polite)
  const stubbornExit = exitOf(stubborn)
  const daemonExit = exitOf(daemon)

  await stopTedProcesses(home, { graceMs: 500 })

  expect(await politeExit).toBe('SIGTERM')
  expect(await daemonExit).toBe('SIGTERM')
  expect(await stubbornExit).toBe('SIGKILL')
})

test('after Quit a Run’s ted command doesn’t start TED again, and the human’s does', async () => {
  await markQuit(home)
  const saved = process.env[runTokenEnv]
  process.env[runTokenEnv] = 'run-capability'
  try {
    await expect(withDaemon(home, async () => 'reached')).rejects.toBeInstanceOf(TedQuitError)
  } finally {
    if (saved === undefined) delete process.env[runTokenEnv]
    else process.env[runTokenEnv] = saved
  }
  expect(await quitMarked(home)).toBe(true)

  const child = spawn(process.execPath, [mainPath], {
    env: { ...process.env, TED_HOME: home },
    stdio: 'ignore',
  })
  children.push(child)
  const [code] = await once(child, 'exit')
  expect(code).toBe(tedQuitExitCode)
  expect(await quitMarked(home)).toBe(true)
})
