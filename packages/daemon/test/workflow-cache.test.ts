import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { type DaemonEvent, readDaemonInfo } from '@ted/protocol'
import { afterEach, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { appClient, commitToOrigin, eventCount, makeOriginRepo, makeTempHome } from './helpers.ts'

const exec = promisify(execFile)
let daemon: RunningDaemon | undefined
let cleanup: (() => Promise<void>) | undefined
let scratch: string | undefined
const originalPath = process.env.PATH

afterEach(async () => {
  await daemon?.stop()
  process.env.PATH = originalPath
  await cleanup?.()
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

test('Board reads share concurrent ref checks, reuse Workflow files and notice a new commit', async () => {
  const temporary = await makeTempHome()
  cleanup = temporary.cleanup
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-workflow-cache-'))
  const origin = await makeOriginRepo(scratch)
  await commitToOrigin(scratch, {
    '.ted/workflow.yaml': 'version: 1\norder: [intake, work]\n',
  })
  const realGit = (await exec('which', ['git'])).stdout.trim()
  const bin = path.join(scratch, 'bin')
  const log = path.join(scratch, 'git-reads.jsonl')
  const failure = path.join(scratch, 'fail-next-blob')
  const refs = path.join(scratch, 'ref-reads.jsonl')
  const slowRefs = path.join(scratch, 'slow-refs')
  await mkdir(bin)
  await writeFile(
    path.join(bin, 'git'),
    `#!/usr/bin/env node
import { appendFileSync, existsSync, unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
if (args[0] === 'rev-parse' && args.includes('origin/main^{commit}') && existsSync(${JSON.stringify(slowRefs)})) {
  appendFileSync(${JSON.stringify(refs)}, 'read\\n')
  await new Promise(resolve => setTimeout(resolve, 100))
}
if (args[0] === 'cat-file' || args[0] === 'ls-tree') appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n')
if (args[0] === 'cat-file' && existsSync(${JSON.stringify(failure)})) {
  unlinkSync(${JSON.stringify(failure)})
  process.exit(1)
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' })
process.exit(result.status ?? 1)
`,
    { mode: 0o700 },
  )
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`
  daemon = await startDaemon({
    home: temporary.home,
    version: '9.9.9',
    integrations: { loginShell: false },
  })
  const info = await readDaemonInfo(temporary.home)
  if (!info) throw new Error('no daemon.json')
  const client = appClient(info, daemon.appToken)
  const factory = await client.addFactory({ repo: origin, key: 'NB' })
  const events: DaemonEvent[] = []
  const subscription = await client.subscribe((e) => events.push(e))
  const before = await client.factoryBoard(factory.id)
  await writeFile(log, '')
  for (let i = 0; i < 3; i++) expect(await client.factoryBoard(factory.id)).toEqual(before)
  expect(await readFile(log, 'utf8')).toBe('')
  await writeFile(slowRefs, '')
  const concurrent = await Promise.all(
    Array.from({ length: 8 }, () => client.factoryBoard(factory.id)),
  )
  for (const board of concurrent) expect(board).toEqual(before)
  expect((await readFile(refs, 'utf8')).trim().split('\n')).toHaveLength(1)
  await rm(slowRefs)
  const accepted = () => eventCount(temporary.home, 'v1.WorkflowLayerAccepted')
  await expect.poll(accepted).toBeGreaterThan(0)
  const acceptedBefore = await accepted()
  await commitToOrigin(scratch, { 'README.md': 'A commit that leaves .ted/ alone\n' })
  await client.factorySettings(factory.id, { refresh: 'first' })
  await client.factoryBoard(factory.id)
  await commitToOrigin(scratch, {
    '.ted/workflow.yaml': 'version: 1\norder: [intake, design, work]\n',
  })
  await writeFile(failure, '')
  await client.factorySettings(factory.id, { refresh: 'first' })
  expect(
    (await client.factoryBoard(factory.id)).stages.some((stage) => stage.id === 'design'),
  ).toBe(true)
  expect(await readFile(log, 'utf8')).not.toBe('')
  await expect.poll(accepted).toBe(acceptedBefore + 1)
  await expect
    .poll(() =>
      events.some((e) => e.type === 'factory-stages-changed' && e.factoryId === factory.id),
    )
    .toBe(true)
  subscription.close()
}, 30_000)
