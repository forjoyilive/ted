import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import type { RunningDaemon } from '../src/index.ts'
import { isAlive } from './helpers.ts'
import { cleanupMergeHarness, ctx, type MergeCleanupEvent } from './merge-harness.ts'
import { eventWait } from './support/event-wait.ts'

async function resources() {
  const root = await mkdtemp(path.join(tmpdir(), 'ted-merge-cleanup-'))
  const home = path.join(root, 'home')
  const scratch = path.join(root, 'scratch')
  await mkdir(home)
  await mkdir(scratch)
  return {
    root,
    home,
    scratch,
    ghState: path.join(scratch, 'gh.json'),
    ghLog: path.join(scratch, 'gh.jsonl'),
    cleanup: () => rm(home, { recursive: true, force: true }),
  }
}

function activate(resource: Awaited<ReturnType<typeof resources>>, daemon?: RunningDaemon) {
  Object.assign(ctx, {
    home: resource.home,
    scratch: resource.scratch,
    cleanup: resource.cleanup,
    ghState: resource.ghState,
    ghLog: resource.ghLog,
    daemon,
  })
  process.env.TED_STUB_GH = resource.ghState
  process.env.TED_STUB_GH_LOG = resource.ghLog
}

function reached(signal: Promise<unknown>, what: string) {
  let ready = false
  return eventWait(
    (changed) => {
      void signal.then(() => {
        ready = true
        changed()
      })
      return () => {}
    },
    () => ready,
    what,
  )
}

test('cleanup reports delayed shutdown and home removal, retaining the host and folders until release', async () => {
  const original = { ...ctx }
  const resource = await resources()
  const stopped = Promise.withResolvers<void>()
  const releaseStop = Promise.withResolvers<void>()
  const removingHome = Promise.withResolvers<void>()
  const releaseHome = Promise.withResolvers<void>()
  const host = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: { ...process.env, TED_HOME: resource.home },
    stdio: 'ignore',
  })
  const exited = once(host, 'exit')
  let cleanup: Promise<void> | undefined
  try {
    await once(host, 'spawn')
    const pid = host.pid
    if (pid === undefined) throw new Error('the fixture host did not start')
    const run = path.join(resource.home, 'runs', 'fixture')
    await mkdir(run, { recursive: true })
    await writeFile(
      path.join(run, 'host.log'),
      `${JSON.stringify({ t: 'start', hostPid: pid, agentPid: null })}\n`,
    )
    activate(resource, {
      port: 0,
      appToken: '',
      reporting: () => false,
      async stop(onStep) {
        onStep?.('services')
        stopped.resolve()
        await releaseStop.promise
      },
    })
    ctx.cleanup = async () => {
      removingHome.resolve()
      await releaseHome.promise
      await resource.cleanup()
    }
    const progress: MergeCleanupEvent[] = []
    cleanup = cleanupMergeHarness((event) => progress.push(event))
    await reached(stopped.promise, 'the held shutdown boundary')
    expect(progress.at(-1)).toMatchObject({ step: 'daemon.services', state: 'start' })
    expect(isAlive(pid)).toBe(true)
    expect((await stat(resource.home)).isDirectory()).toBe(true)
    expect((await stat(resource.scratch)).isDirectory()).toBe(true)

    releaseStop.resolve()
    await reached(removingHome.promise, 'the held home removal boundary')
    await reached(exited, 'the fixture host to exit')
    expect(progress.at(-1)).toMatchObject({ step: 'home', state: 'start' })
    expect(isAlive(pid)).toBe(false)
    expect((await stat(resource.home)).isDirectory()).toBe(true)
    expect((await stat(resource.scratch)).isDirectory()).toBe(true)

    releaseHome.resolve()
    await cleanup
    expect(progress.filter((event) => event.state === 'start').map((event) => event.step)).toEqual([
      'daemon',
      'daemon.services',
      'run-hosts',
      'home',
      'scratch',
    ])
    expect(progress.filter((event) => event.state === 'end')).toHaveLength(5)
    await expect(stat(resource.home)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(resource.scratch)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    releaseStop.resolve()
    releaseHome.resolve()
    try {
      await cleanup
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL')
      try {
        await exited
      } finally {
        Object.assign(ctx, original)
        delete process.env.TED_STUB_GH
        delete process.env.TED_STUB_GH_LOG
        await rm(resource.root, { recursive: true, force: true })
      }
    }
  }
})

test('delayed cleanup removes only its original resources when another test replaces the context', async () => {
  const original = { ...ctx }
  const old = await resources()
  const next = await resources()
  const stopped = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const nextDaemon: RunningDaemon = {
    port: 0,
    appToken: '',
    reporting: () => false,
    stop: async () => {},
  }
  let cleanup: Promise<void> | undefined
  try {
    activate(old, {
      port: 0,
      appToken: '',
      reporting: () => false,
      async stop(onStep) {
        onStep?.('services')
        stopped.resolve()
        await release.promise
      },
    })
    cleanup = cleanupMergeHarness(() => {})
    await reached(stopped.promise, 'old cleanup to enter shutdown')
    activate(next, nextDaemon)
    release.resolve()
    await cleanup

    await expect(stat(old.home)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(old.scratch)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await stat(next.home)).isDirectory()).toBe(true)
    expect((await stat(next.scratch)).isDirectory()).toBe(true)
    expect(ctx).toMatchObject({ home: next.home, scratch: next.scratch, daemon: nextDaemon })
    expect(ctx.cleanup).toBe(next.cleanup)
    expect(process.env.TED_STUB_GH).toBe(next.ghState)
    expect(process.env.TED_STUB_GH_LOG).toBe(next.ghLog)
    await cleanupMergeHarness(() => {})
    await expect(stat(next.home)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(next.scratch)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    release.resolve()
    try {
      await cleanup
    } finally {
      Object.assign(ctx, original)
      delete process.env.TED_STUB_GH
      delete process.env.TED_STUB_GH_LOG
      await rm(old.root, { recursive: true, force: true })
      await rm(next.root, { recursive: true, force: true })
    }
  }
})
