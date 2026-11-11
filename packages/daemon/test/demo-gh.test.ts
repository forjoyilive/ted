import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { prepareDemoBinaries } from '../src/dev/fixtures.ts'
import { demoEnvironment } from '../src/dev/home.ts'

const exec = promisify(execFile)
let home: string
let state: string
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-demo-gh-'))
  state = path.join(home, 'gh.json')
  await prepareDemoBinaries(home)
  await writeFile(state, JSON.stringify({ pr: { numbered: true } }))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})
const create = (head: string) =>
  exec(
    process.execPath,
    [
      path.join(home, 'bin', 'stub-gh.mjs'),
      'pr',
      'create',
      '--repo',
      'demo/garden',
      '--head',
      head,
    ],
    {
      env: { ...process.env, TED_DEMO: '1', TED_STUB_GH: state },
    },
  )

test('concurrent demo pull requests keep every head and receive unique numbers', async () => {
  const [created] = await Promise.all([
    Promise.all(Array.from({ length: 12 }, (_, i) => create(`branch-${i}`))),
    Promise.all(
      Array.from({ length: 12 }, () =>
        exec(process.execPath, [path.join(home, 'bin', 'stub-gh.mjs'), 'auth', 'status'], {
          env: { ...process.env, TED_DEMO: '1', TED_STUB_GH: state },
        }),
      ),
    ),
  ])
  expect(new Set(created.map((r) => r.stdout.trim())).size).toBe(12)
  const saved = JSON.parse(await readFile(state, 'utf8'))
  expect(Object.values(saved.heads).sort()).toEqual(
    Array.from({ length: 12 }, (_, i) => `branch-${i}`).sort(),
  )
  expect(Object.keys(saved.prRepos)).toHaveLength(12)
})

test('a killed fixture process releases its OS lock without deleting the lock file', async () => {
  const file = `${state}.lock.sqlite`
  const holder = exec(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN EXCLUSIVE'); console.log('locked'); setInterval(() => {}, 1000)",
      file,
    ],
    { timeout: 10_000 },
  )
  const ended = holder.catch(() => undefined)
  try {
    if (!holder.child.stdout) throw new Error('The fixture lock process has no output stream.')
    await once(holder.child.stdout, 'data')
    holder.child.kill('SIGKILL')
    await ended
    expect((await create('after-crash')).stdout).toContain('/pull/7')
    await expect(readFile(file)).resolves.toBeDefined()
  } finally {
    holder.child.kill('SIGKILL')
    await ended
  }
})

test('agent wrappers use the existing stubs and keep their compile cache in the demo home', async () => {
  const env = demoEnvironment(home)
  for (const agent of ['claude', 'codex']) {
    const result = await exec(
      process.execPath,
      [path.join(home, 'bin', `stub-${agent}.mjs`), '--version'],
      { env },
    )
    expect(result.stdout.toLowerCase()).toContain(agent)
  }
  expect((await readdir(path.join(home, 'module-cache'))).length).toBeGreaterThan(0)
})
