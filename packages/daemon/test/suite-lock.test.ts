import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { acquireSuiteLock, lockFullRun, pidAlive } from './support/suite-lock.ts'

let dir: string
let file: string
const children: ReturnType<typeof spawn>[] = []

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-suite-lock-'))
  file = path.join(dir, 'lock')
})

afterEach(async () => {
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

  test('a run of a few files doesn’t take the lock', async () => {
    expect(await lockFullRun(3)).toBeUndefined()
  })
})
