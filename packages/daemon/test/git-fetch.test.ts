import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { fetch } from '../src/git.ts'
import { makeOriginRepo } from './helpers.ts'

const run = promisify(execFile)
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-fetch-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const git = async (cwd: string, ...args: string[]) =>
  (
    await run('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    })
  ).stdout.trim()

test('fetches of one clone at the same moment all succeed after the remote moved', async () => {
  const origin = await makeOriginRepo(dir)
  const clone = path.join(dir, 'clone')
  const pusher = path.join(dir, 'pusher')
  await git(dir, 'clone', '-q', origin, clone)
  await git(dir, 'clone', '-q', origin, pusher)

  for (let round = 0; round < 5; round += 1) {
    await git(pusher, 'commit', '-q', '--allow-empty', '-m', `round ${round}`)
    await git(pusher, 'push', '-q', 'origin', 'main')
    const tip = await git(pusher, 'rev-parse', 'HEAD')
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) => fetch(clone, index % 2 === 0 ? undefined : 60_000)),
    )
    expect(results.filter((result) => result.status === 'rejected')).toEqual([])
    expect(await git(clone, 'rev-parse', 'origin/main')).toBe(tip)
  }
}, 60_000)
