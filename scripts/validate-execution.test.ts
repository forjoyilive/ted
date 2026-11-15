import { execFile } from 'node:child_process'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { makeOriginRepo, waitUntil } from '../packages/daemon/test/helpers.ts'
import { ExecutionDiagnostics } from '../packages/daemon/test/support/execution-diagnostics.ts'
import { removeFixtureRoot } from '../packages/daemon/test/support/execution-fixture.ts'
import { selectScenarios } from '../packages/daemon/test/support/execution-manifest.ts'
import { observe } from '../packages/daemon/test/support/execution-observations.ts'
import {
  boundedEvidence,
  candidateIdentity,
  evidenceBytes,
  reportDirectory,
} from '../packages/daemon/test/support/execution-report.ts'
import { findMarked, killMarked } from '../packages/daemon/test/support/processes.ts'
import {
  sandboxReasons,
  skipInsideTedSandbox,
} from '../packages/daemon/test/support/ted-sandbox.ts'
import {
  executeScenario,
  runValidation,
  type ScenarioCommand,
  validationCli,
} from './validate-execution.ts'

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'ted-report-test-')))
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
const candidate = async () => ({
  revision: 'abc',
  contentHash: 'tree',
  dirtyPatchIdentity: 'dirty',
})
const versions = async () => ({ node: '24', pnpm: '10', git: '2' })
const options = () => ({ root: process.cwd(), reportDir: root, scenarios: ['fixture-controls'] })
const passed = {
  success: true,
  numPassedTests: 1,
  numFailedTests: 0,
  numPendingTests: 0,
  testResults: [{ status: 'passed', assertionResults: [{ status: 'passed' }] }],
}
async function successful(command: ScenarioCommand) {
  expect(command.argv.slice(0, 4)).toEqual([
    'pnpm',
    'vitest',
    'run',
    'packages/daemon/test/execution-fixture.test.ts',
  ])
  expect(command.env.TED_RUN_TOKEN).toBeUndefined()
  await writeFile(command.resultFile, JSON.stringify(passed))
  const scenario = selectScenarios(['fixture-controls'])[0]
  if (!scenario) throw new Error('missing fixture scenario')
  await writeFile(
    command.observationsFile,
    scenario.invariants
      .map((invariant) => JSON.stringify({ invariant, observed: 'proved' }))
      .join('\n'),
  )
  return { code: 0, stdout: 'ok', stderr: '' }
}

test('runner selects exact files, reports metadata and observations, and cleans successful scratch', async (context) => {
  skipInsideTedSandbox(context, sandboxReasons.tedHome)
  let scratch = ''
  const result = await runValidation(options(), {
    candidate,
    versions,
    execute: async (command) => {
      scratch = path.dirname(command.resultFile)
      return successful(command)
    },
  })
  expect(result.code).toBe(0)
  expect(result.report).toMatchObject({
    version: 1,
    result: 'pass',
    candidate: await candidate(),
    prerequisites: await versions(),
  })
  expect(result.report.machine).toMatchObject({ platform: process.platform, arch: process.arch })
  expect(result.report.scenarios[0]).toMatchObject({
    evidence: 'isolated loopback integration',
    scope: 'fixture controls',
    result: 'pass',
  })
  expect(result.report.scenarios[0]?.observed).toHaveLength(4)
  expect(
    JSON.parse(await readFile(path.join(result.directory, 'report.json'), 'utf8')),
  ).toMatchObject({ result: 'pass' })
  await expect(access(scratch)).rejects.toThrow()
  expect(await readFile(path.join(result.directory, 'summary.md'), 'utf8')).toContain(
    'Candidate: abc',
  )
  await observe('runner-reporting', { selectedFiles: true, durableReport: true, cleanup: true })
})

test('an owned lab adapter supplies its report allocator without weakening the normal policy', async () => {
  const reportDir = path.join(root, 'ted-validation-lab', 'reports')
  await expect(reportDirectory(reportDir, process.cwd())).rejects.toThrow('fixture scratch')
  await mkdir(reportDir, { recursive: true })
  const result = await runValidation(
    { ...options(), reportDir },
    {
      candidate,
      versions,
      execute: successful,
      reportDirectory: async (requested) => {
        expect(requested).toBe(reportDir)
        return mkdtemp(path.join(reportDir, 'validation-'))
      },
    },
  )
  expect(result.code).toBe(0)
  expect(
    JSON.parse(await readFile(path.join(result.directory, 'report.json'), 'utf8')),
  ).toMatchObject({ result: 'pass' })
})

test('nonzero command preserves bounded redacted evidence and replay argv', async (context) => {
  skipInsideTedSandbox(context, sandboxReasons.tedHome)
  const token = `ghp_${'a'.repeat(30)}`
  let scratch = ''
  const result = await runValidation(options(), {
    candidate,
    versions,
    execute: async (command) => {
      scratch = path.dirname(command.resultFile)
      await successful(command)
      return {
        code: 7,
        stdout: `${token}\n${'x'.repeat(evidenceBytes * 2)}`,
        stderr: 'Bearer secret-token-value',
      }
    },
  })
  expect(result.code).toBe(1)
  expect(result.report.result).toBe('fail')
  expect(result.report.replay).toMatchObject({
    candidate: await candidate(),
    command: expect.arrayContaining(['--scenario', 'fixture-controls']),
  })
  for (const file of result.report.scenarios.flatMap((s) => s.evidencePaths)) {
    const evidence = await readFile(path.join(result.directory, file), 'utf8')
    expect(Buffer.byteLength(evidence)).toBeLessThan(evidenceBytes + 32)
    expect(evidence).not.toContain(token)
    expect(evidence).not.toContain('secret-token-value')
  }
  await expect(access(scratch)).rejects.toThrow()
})

test('assertion details survive scratch cleanup as bounded redacted evidence', async (context) => {
  skipInsideTedSandbox(context, sandboxReasons.tedHome)
  let failure = ''
  try {
    expect('Bearer secret-token-value').toBe('row-1-invariant')
  } catch (error) {
    failure = error instanceof Error ? (error.stack ?? error.message) : String(error)
  }
  let scratch = ''
  const result = await runValidation(options(), {
    candidate,
    versions,
    execute: async (command) => {
      scratch = path.dirname(command.resultFile)
      await successful(command)
      await writeFile(
        command.resultFile,
        JSON.stringify({
          ...passed,
          success: false,
          numPassedTests: 0,
          numFailedTests: 1,
          testResults: [
            {
              name: 'synthetic-ownership.test.ts',
              status: 'failed',
              assertionResults: [
                {
                  fullName: 'ownership assignment is saved before start',
                  status: 'failed',
                  failureMessages: [failure, 'x'.repeat(evidenceBytes * 2)],
                },
              ],
            },
          ],
        }),
      )
      return { code: 1, stdout: '', stderr: '' }
    },
  })
  expect(result.code).toBe(1)
  const evidence = (
    await Promise.all(
      result.report.scenarios
        .flatMap((s) => s.evidencePaths)
        .map((file) => readFile(path.join(result.directory, file), 'utf8')),
    )
  ).join('\n')
  expect(evidence).toContain('ownership assignment is saved before start')
  expect(evidence).toContain('row-1-invariant')
  expect(evidence).toContain('AssertionError')
  expect(evidence).not.toContain('secret-token-value')
  expect(Buffer.byteLength(evidence)).toBeLessThan(2 * 1024 * 1024)
  await expect(access(scratch)).rejects.toThrow()
})

test.for(['missing-observations', 'missing-report', 'malformed-report', 'unfinished', 'throw'])(
  'fails closed for %s',
  async (mode, context) => {
    skipInsideTedSandbox(context, sandboxReasons.tedHome)
    const result = await runValidation(options(), {
      candidate,
      versions,
      execute: async (command) => {
        if (mode === 'throw') throw new Error('failed to spawn')
        await successful(command)
        if (mode === 'missing-observations') await writeFile(command.observationsFile, '')
        if (mode === 'missing-report') await rm(command.resultFile)
        if (mode === 'malformed-report') await writeFile(command.resultFile, '{}')
        if (mode === 'unfinished')
          await writeFile(command.resultFile, JSON.stringify({ ...passed, numPendingTests: 1 }))
        return { code: 0, stdout: '', stderr: '' }
      },
    })
    expect(result.code).toBe(1)
    expect(result.report.scenarios[0]?.result).toBe('fail')
  },
)

test('cleanup failure fails the report even when scenario passed', async (context) => {
  skipInsideTedSandbox(context, sandboxReasons.tedHome)
  const result = await runValidation(options(), {
    candidate,
    versions,
    execute: successful,
    cleanup: async (scratch) => {
      await rm(scratch, { recursive: true, force: true })
      throw new Error('cleanup verification failed')
    },
  })
  expect(result.code).toBe(1)
  expect(result.report.errors.join(' ')).toContain('cleanup failed')
})

test('runner cleans real fixture roots and processes after a worker crashes before teardown', async (context) => {
  skipInsideTedSandbox(context, sandboxReasons.tedHome)
  let owned: { root: string; home: string } | undefined
  try {
    const result = await runValidation(options(), {
      candidate,
      versions,
      execute: async (command) => {
        const output = await executeScenario({
          ...command,
          argv: [process.execPath, 'packages/daemon/test/fixtures/crash-execution-fixture.ts'],
          timeoutMs: 30_000,
        })
        owned = JSON.parse(output.stdout.trim())
        return output
      },
    })
    expect(result.code).toBe(1)
    expect(result.report.errors).toEqual([])
    if (!owned) throw new Error('fixture never reached its readiness barrier')
    expect((await findMarked('TED_HOME', owned.home)).map((process) => process.pid)).toEqual([])
    await expect(access(owned.root)).rejects.toThrow()
  } finally {
    if (owned) {
      await killMarked('TED_HOME', owned.home)
      await removeFixtureRoot(owned.root)
    }
  }
}, 60_000)

test('skip-only run supplies no passing evidence and never invokes executor or machine discovery', async (context) => {
  skipInsideTedSandbox(context, sandboxReasons.tedHome)
  const result = await runValidation(
    { ...options(), scenarios: ['two-mac', 'product-pairing'] },
    {
      candidate,
      versions,
      execute: async () => {
        throw new Error('must not execute')
      },
    },
  )
  expect(result.code).toBe(2)
  expect(result.report.result).toBe('skipped')
  expect(result.report.scenarios.every((s) => s.result === 'skipped' && s.reason)).toBe(true)
  expect(new Set(result.report.scenarios.map((s) => s.evidence)).size).toBe(1)
  await expect(validationCli(['--report-dir', root], true)).rejects.toThrow('--opt-in')
})

test('rejects empty/unknown selections, missing report directory and unsafe output paths', async () => {
  expect(() => selectScenarios([])).toThrow('select')
  expect(() => selectScenarios(['unknown'])).toThrow('unknown')
  await expect(validationCli(['--scenario', 'ownership'])).rejects.toThrow('--report-dir')
  await expect(reportDirectory('relative', process.cwd())).rejects.toThrow('absolute')
  await expect(reportDirectory(process.cwd(), process.cwd())).rejects.toThrow('outside')
  await expect(
    reportDirectory(path.join(root, 'ted-execution-existing', 'reports'), process.cwd()),
  ).rejects.toThrow('scratch')
  for (const home of ['.ted', '.ted-dev'])
    await expect(
      reportDirectory(path.join(homedir(), home, 'validation'), process.cwd()),
    ).rejects.toThrow('outside')
  const link = path.join(root, 'alias')
  await symlink(root, link)
  await expect(reportDirectory(path.join(link, 'reports'), process.cwd())).rejects.toThrow(
    'symlinks',
  )
  await expect(
    reportDirectory(path.join(root, 'scratch', 'reports'), process.cwd(), root),
  ).rejects.toThrow('outside')
})

test('candidate identity includes untracked, dirty and binary content without saving raw patches', async () => {
  await makeOriginRepo(root)
  const seed = path.join(root, 'seed')
  const clean = await candidateIdentity(seed)
  expect(clean.dirtyPatchIdentity).toBeNull()
  await writeFile(path.join(seed, 'new.bin'), Buffer.from([0, 1, 2]))
  const untracked = await candidateIdentity(seed)
  expect(untracked.revision).toBe(clean.revision)
  expect(untracked.contentHash).not.toBe(clean.contentHash)
  expect(untracked.dirtyPatchIdentity).not.toBeNull()
  await writeFile(path.join(seed, 'new.bin'), Buffer.from([0, 1, 3]))
  expect((await candidateIdentity(seed)).dirtyPatchIdentity).not.toBe(untracked.dirtyPatchIdentity)
})

test('report storage excludes a configured home even through its canonical path', async () => {
  const home = path.join(root, 'configured-home')
  const alias = path.join(root, 'configured-home-alias')
  await mkdir(home)
  await symlink(home, alias)
  vi.stubEnv('TED_HOME', alias)
  await expect(reportDirectory(path.join(home, 'reports'), process.cwd())).rejects.toThrow(
    'outside',
  )
  await expect(access(path.join(home, 'reports'))).rejects.toThrow()
})

test('real failing subprocess propagates exit code and bounded timeout', async () => {
  const command: ScenarioCommand = {
    argv: [process.execPath, '-e', 'process.exit(7)'],
    cwd: root,
    env: process.env,
    timeoutMs: 1000,
    resultFile: '',
    observationsFile: '',
  }
  expect((await executeScenario(command)).code).toBe(7)
  expect(
    (
      await executeScenario({
        ...command,
        argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'],
        timeoutMs: 20,
      })
    ).code,
  ).toBe(1)
  const exec = promisify(execFile)
  await expect(
    exec(
      process.execPath,
      ['scripts/validate-execution-lab.ts', '--report-dir', root, '--scenario', 'two-mac'],
      { cwd: process.cwd() },
    ),
  ).rejects.toMatchObject({ code: 1 })
})

test('redacts before enforcing artifact bounds', () => {
  const text = boundedEvidence(`Bearer ${'a'.repeat(100)}\n${'z'.repeat(evidenceBytes * 2)}`)
  expect(text.truncated).toBe(true)
  expect(text.text).toContain('Bearer [redacted]')
  expect(text.text).not.toContain('a'.repeat(100))
})

test('scenario timeout stops its owned subprocess group', async () => {
  if (process.platform === 'win32') return
  const ready = path.join(root, 'child-ready')
  const stopped = path.join(root, 'child-stopped')
  const childSource = `const fs = require('node:fs'); process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(stopped)}, 'stopped'); process.exit(0) }); fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000)`
  const parentSource = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], { stdio: 'inherit' }); setInterval(() => {}, 1000)`
  const result = executeScenario({
    argv: [process.execPath, '-e', parentSource],
    cwd: root,
    env: process.env,
    timeoutMs: 3000,
    resultFile: '',
    observationsFile: '',
  })
  await waitUntil(
    () =>
      access(ready).then(
        () => true,
        () => false,
      ),
    'owned subprocess readiness',
  )
  expect((await result).code).toBe(1)
  expect(await readFile(stopped, 'utf8')).toBe('stopped')
})

test('diagnostic redaction spans stream chunks and omits oversized lines', () => {
  const diagnostic = new ExecutionDiagnostics()
  diagnostic.push('Bearer sec')
  diagnostic.push('ret-token-value\nnext\n')
  expect(diagnostic.text).toContain('Bearer [redacted]')
  expect(diagnostic.text).not.toContain('secret-token-value')
  diagnostic.push('x'.repeat(100_000))
  diagnostic.push('\nend\n')
  expect(diagnostic.text).toContain('[overlong diagnostic line omitted]')
  expect(Buffer.byteLength(diagnostic.text)).toBeLessThan(evidenceBytes)
})

test('report publication failure rejects rather than returning pass', async (context) => {
  skipInsideTedSandbox(context, sandboxReasons.tedHome)
  let reportRoot = ''
  await expect(
    runValidation(options(), {
      candidate,
      versions,
      execute: async (command) => {
        await successful(command)
        const entries = await import('node:fs/promises').then((fs) => fs.readdir(root))
        reportRoot = path.join(
          root,
          entries.find((name) => name.startsWith('validation-')) ?? 'missing',
        )
        await rm(reportRoot, { recursive: true, force: true })
        await writeFile(reportRoot, 'cannot publish a directory here')
        return { code: 0, stdout: '', stderr: '' }
      },
    }),
  ).rejects.toThrow('report publication failed')
})
