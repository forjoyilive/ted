import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { loadWorkerCount, startLoad } from './check-load.ts'
import { evidenceFiles, measureCheck } from './check-measurement.ts'
import { assertHuman, assessEvidence, measurementArgs } from './measure-check.ts'

const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})
function fixture() {
  const folder = mkdtempSync(path.join(tmpdir(), 'ted-measure-'))
  folders.push(folder)
  const cache = path.join(folder, 'cache')
  const evidence = path.join(folder, 'evidence')
  mkdirSync(cache)
  mkdirSync(evidence)
  return { cache, evidence }
}

test('rejects agent contexts, invalid modes and path-like labels', () => {
  for (const name of [
    'TED_RUN',
    'TED_RUN_TOKEN',
    'TED_RUN_CAPABILITY',
    'TED_TASK',
    'TED_PLAN',
    'CODEX_SANDBOX',
  ]) {
    expect(() => assertHuman({ [name]: 'yes' })).toThrow('human')
  }
  expect(() => assertHuman({})).not.toThrow()
  for (const args of [[], ['quiet', '../escape'], ['busy', 'one'], ['quiet', 'one', 'extra']]) {
    expect(() => measurementArgs(args)).toThrow('Usage')
  }
  expect(measurementArgs(['loaded', 'loaded-1'])).toEqual({ mode: 'loaded', label: 'loaded-1' })
})

test('uses half the logical CPUs rounded up and terminates its ready workload', async () => {
  expect([1, 2, 3, 8].map(loadWorkerCount)).toEqual([1, 1, 2, 4])
  const load = await startLoad(1)
  await expect(load.stop()).resolves.toBeUndefined()
})

test('never copies another suite’s artifacts when installation fails', () => {
  const { cache, evidence } = fixture()
  const measure = measureCheck(evidence, cache)
  measure?.start('install')
  writeFileSync(path.join(cache, 'ted-test-failures.json'), 'other suite')
  measure?.end('install')
  measure?.finish(false)
  const result = JSON.parse(readFileSync(path.join(evidence, 'check-measurement.json'), 'utf8'))
  expect(result.artifacts).toEqual({})
  expect(result.lockWaitMs).toBeNull()
  expect(result.workMs).toBeNull()
  expect(result.testProcessEnvelopeMs).toBeNull()
})

test('snapshots while locked, keeps fresh identical retries and excludes stale timing/history', () => {
  const { cache, evidence } = fixture()
  const retry = 'ted-test-retries-node.json'
  const history = 'ted-test-failures.json'
  writeFileSync(path.join(cache, retry), '{"passedOnRetry":[]}')
  const measure = measureCheck(evidence, cache)
  measure?.start('lock')
  writeFileSync(path.join(cache, history), 'other suite completed while we waited')
  measure?.end('lock')
  measure?.start('Test electron')
  measure?.start('Test node')
  writeFileSync(path.join(cache, retry), '{"passedOnRetry":[]}')
  measure?.end('Test electron')
  measure?.end('Test node')
  measure?.finish(false)
  const result = JSON.parse(readFileSync(path.join(evidence, 'check-measurement.json'), 'utf8'))
  expect(Object.keys(result.artifacts)).toEqual([retry])
  expect(result.totalMs).toBeCloseTo(result.workMs + result.lockWaitMs)
  expect(result.testProcessEnvelopeMs).toBeGreaterThanOrEqual(0)
})

test('collects an isolated stub Check and refuses dirty trees and reused labels', () => {
  const { cache } = fixture()
  const root = path.dirname(cache)
  const scripts = path.join(root, 'scripts')
  const bin = path.join(root, 'node_modules', 'bin')
  mkdirSync(scripts)
  mkdirSync(bin, { recursive: true })
  for (const file of ['measure-check.ts', 'check-load.ts', 'check-measurement.ts']) {
    copyFileSync(path.join(import.meta.dirname, file), path.join(scripts, file))
  }
  writeFileSync(path.join(root, '.gitignore'), 'node_modules/\ncache/\nevidence/\n')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  git('init')
  git('add', '.')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture')
  writeFileSync(
    path.join(bin, 'pnpm'),
    `#!${process.execPath}
    const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
    if (process.argv[2] === '--version') { console.log('fixture'); process.exit(0) }
    const dir = process.env.TED_CHECK_EVIDENCE_DIR
    const artifacts = Object.fromEntries(${JSON.stringify(evidenceFiles)}.map(name => {
      fs.writeFileSync(path.join(dir, name), JSON.stringify({ passedOnRetry: [] }))
      return [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')]
    }))
    fs.writeFileSync(path.join(dir, 'check-measurement.json'), JSON.stringify({ ok: true, workMs: 100, testProcessEnvelopeMs: 50, artifacts }))
    console.log('STUB CHECK ONLY')
  `,
    { mode: 0o755 },
  )
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  }
  for (const key of [
    'TED_RUN',
    'TED_RUN_TOKEN',
    'TED_RUN_CAPABILITY',
    'TED_TASK',
    'TED_PLAN',
    'CODEX_SANDBOX',
  ])
    delete env[key]
  const invoke = (label: string) =>
    spawnSync(process.execPath, [path.join(scripts, 'measure-check.ts'), 'quiet', label], {
      env,
      encoding: 'utf8',
    })
  const result = invoke('quiet-1')
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('STUB CHECK ONLY')
  const folder = path.join(root, 'node_modules/.cache/suite-measurements/quiet-1')
  expect(assessEvidence(folder)).toMatchObject({ reliablePass: true, withinTarget: true })
  const run = JSON.parse(readFileSync(path.join(folder, 'run.json'), 'utf8'))
  expect(run.commit).toBe(run.endCommit)
  expect(run.dirtyAtEnd).toBe(false)
  expect(run.workers).toBe(0)
  expect(run.samples.length).toBeGreaterThan(0)
  expect(invoke('quiet-1').status).toBe(1)
  writeFileSync(path.join(root, 'dirty'), 'changed')
  const dirty = invoke('quiet-2')
  expect(dirty.status).toBe(1)
  expect(dirty.stderr).toContain('Commit all changes')
  writeFileSync(path.join(folder, 'ted-test-retries-node.json'), '{"passedOnRetry":["flaky"]}')
  expect(assessEvidence(folder)).toMatchObject({ reliablePass: false, withinTarget: true })
  rmSync(path.join(folder, 'check-measurement.json'))
  expect(assessEvidence(folder).reliablePass).toBe(false)
})

test('workload CLI shuts down cleanly on SIGTERM', async () => {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'check-load.ts'), '1'], {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let errors = ''
  child.stderr.on('data', (chunk) => {
    errors += chunk.toString()
  })
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', () => reject(new Error('Workload exited before readiness')))
      child.stdout.once('data', (chunk: Buffer) => {
        if (chunk.toString().trim() === 'READY') resolve()
        else reject(new Error('Invalid readiness'))
      })
    })
    const closed = new Promise<number | null>((resolve) => child.once('close', resolve))
    child.kill('SIGTERM')
    expect(await closed).toBe(0)
    expect(errors).toBe('')
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})
