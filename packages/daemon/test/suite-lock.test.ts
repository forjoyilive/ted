import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  acquireFullRun,
  acquireSlot,
  acquireSuiteLock,
  heldLockEnv,
  lockRun,
  pidAlive,
  runRefusal,
  type WaitRecord,
} from './support/suite-lock.ts'

let dir: string
let file: string
const children: ReturnType<typeof spawn>[] = []

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-suite-lock-'))
  file = path.join(dir, 'lock')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const child of children.splice(0)) child.kill()
  await rm(dir, { recursive: true, force: true })
})

function liveProcess(): number {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
    env: { ...process.env },
  })
  children.push(child)
  return child.pid ?? 0
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { env: { ...process.env } })
  await new Promise((resolve) => child.on('exit', resolve))
  return child.pid ?? 0
}

describe('the test suite lock', () => {
  test('a free lock is taken with the pid and released', async () => {
    const release = await acquireSuiteLock({ file, pid: 4242 })
    expect(await readFile(file, 'utf8')).toBe('4242\n')
    await release()
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('the same process takes it again, as both Vitest projects of one run do', async () => {
    await acquireSuiteLock({ file, pid: process.pid })
    await acquireSuiteLock({ file, pid: process.pid, pollMs: 10 })
    expect(await readFile(file, 'utf8')).toBe(`${process.pid}\n`)
  })

  test('a lock whose pid is dead is taken over', async () => {
    const dead = await deadPid()
    expect(pidAlive(dead)).toBe(false)
    await writeFile(file, `${dead}\n`)
    const waited: number[] = []
    await acquireSuiteLock({ file, pid: 4242, pollMs: 10, onWait: (pid) => waited.push(pid) })
    expect(await readFile(file, 'utf8')).toBe('4242\n')
    expect(waited).toEqual([])
  })

  test('a second run waits, says once whom it waits for, and starts when the first ends', async () => {
    const first = liveProcess()
    await writeFile(file, `${first}\n`)
    const waited: number[] = []
    let taken = false
    const second = acquireSuiteLock({
      file,
      pid: 4242,
      pollMs: 20,
      onWait: (pid) => waited.push(pid),
    }).then(() => {
      taken = true
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(taken).toBe(false)
    expect(waited).toEqual([first])

    children[0]?.kill()
    await second
    expect(await readFile(file, 'utf8')).toBe('4242\n')
    expect(waited).toEqual([first])
  })

  test('a run of a few files takes a slot and leaves the suite lock alone', async () => {
    const slots = { dir: path.join(dir, 'slots'), suiteLock: file, slots: 2 }
    const release = await lockRun(3, slots)
    expect(await readFile(path.join(slots.dir, '0.lock'), 'utf8')).toBe(`${process.pid}\n`)
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await release?.()
    await expect(readFile(path.join(slots.dir, '0.lock'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('test slots', () => {
  const slots = () => ({ dir: path.join(dir, 'slots'), suiteLock: file, slots: 2, pollMs: 20 })
  const slot = (index: number) => path.join(dir, 'slots', `${index}.lock`)
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  test('small runs take one slot each, and the same process keeps its slot', async () => {
    const first = liveProcess()
    await acquireSlot({ ...slots(), pid: first })
    await acquireSlot({ ...slots(), pid: process.pid })
    await acquireSlot({ ...slots(), pid: process.pid })
    expect(await readFile(slot(0), 'utf8')).toBe(`${first}\n`)
    expect(await readFile(slot(1), 'utf8')).toBe(`${process.pid}\n`)
  })

  test('a nested run borrows its parent’s slot without taking or releasing another slot', async () => {
    const release = await acquireSlot(slots())
    vi.stubEnv(heldLockEnv, String(process.pid))
    expect(await lockRun(1, slots())).toBeUndefined()
    expect(await readFile(slot(0), 'utf8')).toBe(`${process.pid}\n`)
    await expect(readFile(slot(1), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await release?.()
  })

  test('a small run waits while every slot is held and starts when one is free', async () => {
    const first = liveProcess()
    const second = liveProcess()
    await mkdir(path.join(dir, 'slots'))
    await writeFile(slot(0), `${first}\n`)
    await writeFile(slot(1), `${second}\n`)
    const waited: number[] = []
    let taken = false
    const third = acquireSlot({ ...slots(), pid: 4242, onWait: (pid) => waited.push(pid) }).then(
      () => {
        taken = true
      },
    )
    await pause(200)
    expect(taken).toBe(false)
    expect(waited).toEqual([second])

    children[0]?.kill()
    await third
    expect(await readFile(slot(0), 'utf8')).toBe('4242\n')
  })

  test('a full run takes the suite lock and every slot, and waits for small runs to end', async () => {
    const small = liveProcess()
    await mkdir(path.join(dir, 'slots'))
    await writeFile(slot(1), `${small}\n`)
    let taken = false
    const full = acquireFullRun({ ...slots(), pid: 4242 }).then((release) => {
      taken = true
      return release
    })
    await pause(200)
    expect(taken).toBe(false)
    expect(await readFile(file, 'utf8')).toBe('4242\n')

    children[0]?.kill()
    const release = await full
    expect(await readFile(slot(0), 'utf8')).toBe('4242\n')
    expect(await readFile(slot(1), 'utf8')).toBe('4242\n')
    await release()
    for (const held of [file, slot(0), slot(1)]) {
      await expect(readFile(held, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  test('a small run doesn’t take a free slot while a full run holds the suite lock', async () => {
    const full = liveProcess()
    await writeFile(file, `${full}\n`)
    const waited: number[] = []
    let taken = false
    const small = acquireSlot({ ...slots(), pid: 4242, onWait: (pid) => waited.push(pid) }).then(
      () => {
        taken = true
      },
    )
    await pause(200)
    expect(taken).toBe(false)
    expect(waited).toEqual([full])

    children[0]?.kill()
    await small
    expect(await readFile(slot(0), 'utf8')).toBe('4242\n')
  })

  test('a run that holds a slot keeps it when a full run takes the suite lock, as its second Vitest project does', async () => {
    const release = await acquireSlot({ ...slots(), pid: process.pid })
    await writeFile(file, `${liveProcess()}\n`)
    const again = await acquireSlot({ ...slots(), pid: process.pid })
    expect(again).toBeDefined()
    expect(await readFile(slot(0), 'utf8')).toBe(`${process.pid}\n`)
    await release?.()
  })

  test('when a full run ends, the small runs already waiting go before the next full run', async () => {
    const running = liveProcess()
    await mkdir(path.join(dir, 'slots'))
    for (const held of [file, slot(0), slot(1)]) await writeFile(held, `${running}\n`)
    const order: string[] = []
    const firstSmall = liveProcess()
    const full = liveProcess()
    const lastSmall = liveProcess()
    const big = acquireFullRun({ ...slots(), pid: full }).then((release) => {
      order.push('full')
      return release
    })
    await pause(30)
    const small = acquireSlot({ ...slots(), pid: firstSmall }).then((release) => {
      order.push('first small')
      return release
    })
    await pause(30)
    const late = acquireSlot({ ...slots(), pid: lastSmall }).then((release) => {
      order.push('last small')
      return release
    })
    await pause(200)
    expect(order).toEqual([])
    expect(await readFile(file, 'utf8')).toBe(`${running}\n`)

    children[0]?.kill()
    const releaseSmall = await small
    const afterFull = acquireSlot({ ...slots(), pid: 4242 }).then((release) => {
      order.push('small after the full run')
      return release
    })
    await releaseSmall?.()
    const releaseLate = await late
    await pause(200)
    expect(order).toEqual(['first small', 'last small'])
    expect(await readFile(file, 'utf8')).toBe(`${full}\n`)
    for (const index of [0, 1])
      expect(await readFile(slot(index), 'utf8').catch(() => '')).not.toBe('4242\n')
    await releaseLate?.()
    const releaseFull = await big
    await pause(100)
    expect(order).toEqual(['first small', 'last small', 'full'])
    await releaseFull()
    await (await afterFull)?.()
    expect(order).toEqual(['first small', 'last small', 'full', 'small after the full run'])
  })

  test('a full run stops letting small runs go first after yieldMs', async () => {
    const held = [liveProcess(), liveProcess()]
    await mkdir(path.join(dir, 'slots'))
    await writeFile(slot(0), `${held[0]}\n`)
    await writeFile(slot(1), `${held[1]}\n`)
    let small = false
    const waiting = acquireSlot({ ...slots(), pid: liveProcess() }).then((release) => {
      small = true
      return release
    })
    await pause(30)
    const full = acquireFullRun({ ...slots(), pid: 4242, yieldMs: 100 })
    await pause(60)
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await pause(200)
    expect(await readFile(file, 'utf8')).toBe('4242\n')
    expect(small).toBe(false)

    children[0]?.kill()
    children[1]?.kill()
    await (await full)()
    await (await waiting)?.()
  })

  test('a full run doesn’t let small runs go first while a run from a checkout with the older lock code waits', async () => {
    const held = [liveProcess(), liveProcess()]
    const queue = path.join(dir, 'slots', 'queue')
    await mkdir(queue, { recursive: true })
    await writeFile(slot(0), `${held[0]}\n`)
    await writeFile(slot(1), `${held[1]}\n`)
    const big = acquireFullRun({ ...slots(), pid: 4242 })
    await pause(30)
    const older = `${String(Date.now()).padStart(15, '0')}-${liveProcess()}`
    await writeFile(path.join(queue, older), '')
    await pause(5)
    let small = false
    const waiting = acquireSlot({ ...slots(), pid: liveProcess() }).then((release) => {
      small = true
      return release
    })
    await pause(100)
    children[0]?.kill()
    children[1]?.kill()
    const releaseFull = await big
    expect(small).toBe(false)

    await releaseFull()
    await pause(100)
    expect(small).toBe(false)
    await rm(path.join(queue, older))
    await (await waiting)?.()
  })

  test('a waiting run whose process died doesn’t hold up the runs behind it', async () => {
    const holder = liveProcess()
    await mkdir(path.join(dir, 'slots', 'queue'), { recursive: true })
    await writeFile(slot(0), `${holder}\n`)
    await writeFile(path.join(dir, 'slots', 'queue', `000000000000001-${await deadPid()}`), '')
    const release = await acquireSlot({ ...slots(), pid: 4242 })
    expect(await readFile(slot(1), 'utf8')).toBe('4242\n')
    await release?.()
  })

  test('a slot folder that can’t be made runs without a slot', async () => {
    await writeFile(path.join(dir, 'slots'), '')
    expect(await acquireSlot({ ...slots(), pid: 4242 })).toBeUndefined()
  })
})

describe('the wait log', () => {
  const slots = () => ({ dir: path.join(dir, 'slots'), suiteLock: file, slots: 2, pollMs: 20 })
  const records = async (): Promise<WaitRecord[]> =>
    (await readFile(path.join(dir, 'test-waits.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))

  test('a small run and a full run each record when they started and ended', async () => {
    const holder = liveProcess()
    await mkdir(path.join(dir, 'slots'))
    await writeFile(path.join(dir, 'slots', '0.lock'), `${holder}\n`)
    await writeFile(path.join(dir, 'slots', '1.lock'), `${holder}\n`)
    setTimeout(() => children[0]?.kill(), 150)
    const small = await lockRun(3, slots())
    await small?.()
    const full = await lockRun(12, slots())
    await full?.()
    await (await acquireSlot({ ...slots(), log: path.join(dir, 'elsewhere.jsonl') }))?.()

    const lines = await records()
    expect(lines).toMatchObject([
      { event: 'start', kind: 'small', files: 3, pid: process.pid, cwd: process.cwd() },
      { event: 'end', kind: 'small', files: 3 },
      { event: 'start', kind: 'full', files: 12 },
      { event: 'end', kind: 'full', files: 12 },
    ])
    expect(lines[0]?.waitedMs).toBeGreaterThanOrEqual(100)
    expect(lines[1]?.waitedMs).toBe(lines[0]?.waitedMs)
    expect(lines[1]?.heldMs).toBeGreaterThanOrEqual(0)
    expect(lines[2]?.waitedMs).toBeLessThan(lines[0]?.waitedMs ?? 0)
  })
})

describe('a test run started by a Run', () => {
  test('is refused over 3 files, and lockRun takes no lock', async () => {
    expect(runRefusal(3, { TED_RUN: 'run-1' })).toBeUndefined()
    expect(runRefusal(40, {})).toBeUndefined()
    expect(runRefusal(4, { TED_RUN: 'run-1' })).toContain('pnpm vitest run <files>')

    vi.stubEnv('TED_RUN', 'run-1')
    const slots = { dir: path.join(dir, 'slots'), suiteLock: file }
    await expect(lockRun(4, slots)).rejects.toThrow('A Run can’t start a test run of 4 files')
    await expect(readFile(path.join(slots.dir, '0.lock'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await (await lockRun(3, slots))?.()
  })
})
