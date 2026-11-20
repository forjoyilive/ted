import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  checkSettings,
  parseSettingsResult,
  type RunBranchChecker,
  settingsCheckEntry,
} from '../src/tasks/settings-check.ts'
import type { CommandResult } from '../src/tasks/worktree.ts'
import { parseLibraryNames } from '../src/workflow/check-path.ts'

const repoRoot = path.resolve(import.meta.dirname, '../../..')

let scratch: string
let worktree: string
let library: string
let log: string

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-settings-check-'))
  worktree = path.join(scratch, 'worktree')
  library = path.join(scratch, 'library')
  log = path.join(scratch, 'logs', 'check.log')
  await mkdir(path.join(worktree, '.ted'), { recursive: true })
  await mkdir(library)
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

function workflowWithGroup(group: string): string {
  return [
    'version: 1',
    'stages:',
    '  validate:',
    '    checks:',
    '      - name: Build',
    '        run: make',
    `        sandbox_access: [${group}]`,
    '',
  ].join('\n')
}

async function useWorkflow(text: string): Promise<void> {
  await writeFile(path.join(worktree, '.ted', 'workflow.yaml'), text)
}

async function makeTedSource(entry?: string): Promise<void> {
  await writeFile(path.join(worktree, 'package.json'), JSON.stringify({ name: 'ted' }))
  const file = path.join(worktree, settingsCheckEntry)
  await mkdir(path.dirname(file), { recursive: true })
  if (entry === undefined) await symlink(path.join(repoRoot, settingsCheckEntry), file)
  else await writeFile(file, entry)
}

function outFile(command: string): string {
  const out = /--out (\S+)/.exec(command)?.[1]
  if (out === undefined) throw new Error(`no --out in ${command}`)
  return path.join(worktree, out)
}

function writesResult(result: string): RunBranchChecker & { commands: string[] } {
  const commands: string[] = []
  const run = async (command: string): Promise<CommandResult> => {
    commands.push(command)
    await writeFile(outFile(command), result)
    return { outcome: 'passed', exitCode: 0 }
  }
  return Object.assign(run, { commands })
}

const spawnBranchChecker: RunBranchChecker = (command) =>
  new Promise((resolve) => {
    execFile('/bin/sh', ['-c', command], { cwd: worktree }, async (error, stdout, stderr) => {
      await mkdir(path.dirname(log), { recursive: true })
      await writeFile(log, `${stdout}${stderr}`)
      const code = error ? 1 : 0
      resolve({ outcome: code === 0 ? 'passed' : 'failed', exitCode: code })
    })
  })

const clean = JSON.stringify({ problems: [] })

describe('the Ted settings Check', () => {
  test('outside Ted’s own source it uses the installed checker and never runs branch code', async () => {
    await writeFile(path.join(worktree, 'package.json'), JSON.stringify({ name: 'other' }))
    await useWorkflow(workflowWithGroup('network'))
    const runner = writesResult(clean)

    const result = await checkSettings({
      worktree,
      log,
      libraryDir: library,
      runBranchChecker: runner,
    })

    expect(result).toEqual({ outcome: 'failed', exitCode: 1 })
    expect(runner.commands).toEqual([])
    const text = await readFile(log, 'utf8')
    expect(text).toContain('.ted/workflow.yaml:7:')
    expect(text).toContain('`network` isn’t a sandbox access group')
    expect(text).not.toContain('this branch’s own')
  })

  test('in Ted’s own source the branch’s checker decides, and the installed checker’s errors become warnings', async () => {
    await makeTedSource('')
    await useWorkflow(workflowWithGroup('network'))
    await writeFile(
      path.join(library, 'workflow.yaml'),
      'version: 1\nsandbox_sockets: { docker: /private/sockets/docker.sock }\n',
    )
    await writeFile(path.join(library, 'notes.md'), 'private library notes\n')
    let handed: string | undefined
    const runner = writesResult(clean)
    const result = await checkSettings({
      worktree,
      log,
      libraryDir: library,
      runBranchChecker: async (command) => {
        const file = /--library-names (\S+)/.exec(command)?.[1] ?? ''
        handed = await readFile(path.join(worktree, file), 'utf8')
        return runner(command)
      },
    })

    expect(result).toEqual({ outcome: 'passed', exitCode: 0 })
    expect(runner.commands[0]).toMatch(
      /^node packages\/daemon\/src\/workflow\/check-entry\.ts --target \.ted --library-names node_modules\/\.cache\/ted-settings-\w+\/library-names\.json --out node_modules\/\.cache\/ted-settings-\w+\/result\.json$/,
    )
    expect(JSON.parse(handed ?? '')).toEqual({
      stageFiles: [],
      agentsDefined: [],
      agentsInstructed: [],
      sockets: ['docker'],
    })
    expect(handed).not.toContain('/private/sockets')
    expect(handed).not.toContain('private library notes')
    const text = await readFile(log, 'utf8')
    expect(text).toContain('Checked with this branch’s own Ted settings checker.')
    expect(text).toContain('No problems in .ted')
    expect(text).toContain('the Factory uses its last valid settings')
    expect(text).toMatch(
      /\.ted\/workflow\.yaml:7:\d+: warning: `network` isn’t a sandbox access group/,
    )
  })

  test('in Ted’s own source the branch’s errors fail the Check', async () => {
    await makeTedSource('')
    await useWorkflow(workflowWithGroup('electron'))
    const problem = {
      severity: 'error',
      file: '.ted/workflow.yaml',
      line: 3,
      column: 5,
      message: 'something is wrong',
      path: '.ted/workflow.yaml',
    }
    const result = await checkSettings({
      worktree,
      log,
      libraryDir: library,
      runBranchChecker: writesResult(JSON.stringify({ problems: [problem] })),
    })

    expect(result).toEqual({ outcome: 'failed', exitCode: 1 })
    expect(await readFile(log, 'utf8')).toContain(
      '.ted/workflow.yaml:3:5: error: something is wrong',
    )
  })

  test('when the branch’s checker gives no readable result, the installed checker decides and says why', async () => {
    await makeTedSource('')
    await useWorkflow(workflowWithGroup('network'))

    const missing = await checkSettings({
      worktree,
      log,
      libraryDir: library,
      runBranchChecker: async () => {
        await mkdir(path.dirname(log), { recursive: true })
        await writeFile(log, 'Cannot find package @ted/protocol\n')
        return { outcome: 'failed', exitCode: 1 }
      },
    })
    expect(missing).toEqual({ outcome: 'failed', exitCode: 1 })
    let text = await readFile(log, 'utf8')
    expect(text).toContain(
      'gave no result (it exited with code 1), so the installed checker was used',
    )
    expect(text).toContain('Cannot find package @ted/protocol')
    expect(text).toContain('`network` isn’t a sandbox access group')

    const garbled = await checkSettings({
      worktree,
      log,
      libraryDir: library,
      runBranchChecker: writesResult('{"problems": "none"}'),
    })
    expect(garbled).toEqual({ outcome: 'failed', exitCode: 1 })
    text = await readFile(log, 'utf8')
    expect(text).toContain('its result wasn’t readable: problems must be a list')
  })

  test('an interrupted branch checker interrupts the Check', async () => {
    await makeTedSource('')
    await useWorkflow(workflowWithGroup('electron'))
    const result = await checkSettings({
      worktree,
      log,
      libraryDir: library,
      runBranchChecker: async () => ({ outcome: 'interrupted' }),
    })
    expect(result).toEqual({ outcome: 'interrupted' })
  })

  test('the real entry file checks the branch’s settings and writes its result', async () => {
    await makeTedSource()
    await useWorkflow(workflowWithGroup('electron'))
    expect(
      await checkSettings({
        worktree,
        log,
        libraryDir: library,
        runBranchChecker: spawnBranchChecker,
      }),
    ).toEqual({ outcome: 'passed', exitCode: 0 })
    expect(await readFile(log, 'utf8')).toContain(
      'Checked with this branch’s own Ted settings checker.',
    )

    await useWorkflow(workflowWithGroup('no-such-group'))
    expect(
      await checkSettings({
        worktree,
        log,
        libraryDir: library,
        runBranchChecker: spawnBranchChecker,
      }),
    ).toEqual({ outcome: 'failed', exitCode: 1 })
    const text = await readFile(log, 'utf8')
    expect(text).toContain('Checked with this branch’s own Ted settings checker.')
    expect(text).toMatch(
      /\.ted\/workflow\.yaml:7:\d+: error: `no-such-group` isn’t a sandbox access group/,
    )
  })
})

describe('parseSettingsResult', () => {
  test('reads every field of each problem', () => {
    expect(
      parseSettingsResult({
        problems: [
          {
            severity: 'warning',
            file: '.ted/workflow.yaml',
            line: 2,
            column: 4,
            message: 'unknown key `x`',
            path: '.ted/workflow.yaml',
          },
        ],
      }),
    ).toEqual([
      {
        severity: 'warning',
        file: '.ted/workflow.yaml',
        line: 2,
        column: 4,
        message: 'unknown key `x`',
        path: '.ted/workflow.yaml',
      },
    ])
  })

  test('refuses a result that isn’t the agreed shape', () => {
    expect(() => parseSettingsResult(undefined)).toThrow('result must be an object')
    expect(() => parseSettingsResult({ problems: [{ severity: 'fatal' }] })).toThrow('severity')
    expect(() =>
      parseSettingsResult({
        problems: [{ severity: 'error', file: 'a', line: 1.5, column: 1, message: 'm', path: 'a' }],
      }),
    ).toThrow('line must be a whole number')
  })
})

describe('parseLibraryNames', () => {
  test('reads every field, and null means no valid Library', () => {
    const names = {
      stageFiles: ['qa'],
      order: ['intake', 'qa'],
      agentsDefined: ['helper'],
      agentsInstructed: ['helper'],
      sockets: ['docker'],
    }
    expect(parseLibraryNames(names)).toEqual(names)
    expect(parseLibraryNames({ ...names, order: undefined })).not.toHaveProperty('order')
    expect(parseLibraryNames(null)).toBeUndefined()
  })

  test('refuses names that aren’t text', () => {
    expect(() =>
      parseLibraryNames({ stageFiles: [1], agentsDefined: [], agentsInstructed: [], sockets: [] }),
    ).toThrow('stageFiles[0] must be text')
    expect(() => parseLibraryNames({ stageFiles: [] })).toThrow('agentsDefined must be a list')
  })
})
