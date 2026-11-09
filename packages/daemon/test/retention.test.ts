import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { pruneRunOutput } from '../src/retention.ts'

let root: string
let runsDir: string
const now = new Date('2026-11-08T12:00:00Z')
const day = 24 * 60 * 60 * 1000

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ted-retention-'))
  runsDir = path.join(root, 'runs')
  await mkdir(runsDir)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function makeRun(id: string, log: string, stoppedDaysAgo: number): Promise<string> {
  const dir = path.join(runsDir, id)
  await mkdir(dir)
  await writeFile(path.join(dir, 'launch.json'), '{}')
  const file = path.join(dir, 'host.log')
  await writeFile(file, log)
  const at = new Date(now.getTime() - stoppedDaysAgo * day)
  await utimes(file, at, at)
  return dir
}

const line = (n: number) => `${JSON.stringify({ t: 'out', line: `line ${n}`.padEnd(90, '.') })}\n`

describe('pruning raw Run output', () => {
  test('removes a stopped Run’s output 14 days after it stopped, and keeps newer output', async () => {
    await makeRun('a1b2c3d4-0000-4000-8000-000000000001', line(1), 15)
    await makeRun('a1b2c3d4-0000-4000-8000-000000000002', line(1), 13)

    const result = await pruneRunOutput({ runsDir, isLive: () => false, now })

    expect(result.removed).toEqual(['a1b2c3d4-0000-4000-8000-000000000001'])
    expect(await readdir(runsDir)).toEqual(['a1b2c3d4-0000-4000-8000-000000000002'])
  })

  test('keeps only the newest whole lines when a stopped Run’s output is over the limit', async () => {
    const id = 'a1b2c3d4-0000-4000-8000-000000000003'
    const lines = Array.from({ length: 50 }, (_, i) => line(i))
    await makeRun(id, lines.join(''), 1)

    const result = await pruneRunOutput({ runsDir, isLive: () => false, now, maxBytes: 1000 })

    expect(result.trimmed).toEqual([id])
    const kept = await readFile(path.join(runsDir, id, 'host.log'), 'utf8')
    expect(kept.length).toBeLessThanOrEqual(1000)
    expect(kept.endsWith(lines.at(-1) as string)).toBe(true)
    for (const row of kept.trimEnd().split('\n')) expect(() => JSON.parse(row)).not.toThrow()
  })

  test('leaves a live Run’s output alone, however old or large', async () => {
    const id = 'a1b2c3d4-0000-4000-8000-000000000004'
    await makeRun(id, line(1).repeat(40), 30)

    const result = await pruneRunOutput({
      runsDir,
      isLive: (runId) => runId === id,
      now,
      maxBytes: 100,
    })

    expect(result).toEqual({ removed: [], trimmed: [] })
    expect((await stat(path.join(runsDir, id, 'host.log'))).size).toBe(line(1).length * 40)
  })

  test('never follows a link or touches anything that isn’t a Run folder', async () => {
    const outside = path.join(root, 'outside')
    await mkdir(outside)
    await writeFile(path.join(outside, 'host.log'), line(1))
    const old = new Date(now.getTime() - 30 * day)
    await utimes(path.join(outside, 'host.log'), old, old)
    await symlink(outside, path.join(runsDir, 'a1b2c3d4-0000-4000-8000-000000000005'))
    await writeFile(path.join(runsDir, 'notes.txt'), 'keep me')
    await mkdir(path.join(runsDir, '..weird'))

    const result = await pruneRunOutput({ runsDir, isLive: () => false, now })

    expect(result).toEqual({ removed: [], trimmed: [] })
    expect(await readdir(outside)).toEqual(['host.log'])
    expect((await readdir(runsDir)).sort()).toEqual(
      ['..weird', 'a1b2c3d4-0000-4000-8000-000000000005', 'notes.txt'].sort(),
    )
  })
})
