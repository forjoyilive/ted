import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { DaemonClient, readDaemonInfo, tedVersion } from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../../daemon/src/index.ts'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../src/main.ts', import.meta.url))
let scratch: string
let home: string
let markers: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'ted-local-factory-')))
  home = path.join(scratch, 'home')
  markers = path.join(scratch, 'markers')
  await mkdir(markers)
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await rm(scratch, { recursive: true, force: true })
})

async function git(cwd: string, ...args: string[]) {
  await exec('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  })
}

async function makeSourceRepo(): Promise<string> {
  const folder = path.join(scratch, 'widgets')
  await mkdir(path.join(folder, '.ted'), { recursive: true })
  const touch = (name: string) => `touch ${JSON.stringify(path.join(markers, name))}`
  await writeFile(
    path.join(folder, '.ted', 'workflow.yaml'),
    `version: 1
order: [intake, clarify, design, work, validate, review, merge]
stages:
  validate:
    checks:
      - { name: Tests, run: '${touch('check')}' }
repos:
  - name: widgets
    remote: https://github.com/acme/widgets
    worktree:
      setup: '${touch('setup')}'
      teardown: '${touch('teardown')}'
    apps:
      - { name: Web, run: '${touch('app')}', port: 4987, url: 'http://localhost:4987' }
`,
  )
  await git(scratch, 'init', '--initial-branch=main', folder)
  await git(folder, 'add', '.')
  await git(folder, 'commit', '-m', 'first')
  return folder
}

async function ted(...args: string[]) {
  const recorder = path.join(scratch, 'gh')
  await writeFile(
    recorder,
    `#!/bin/sh\ntouch ${JSON.stringify(path.join(markers, 'gh'))}\nexit 1\n`,
  )
  await chmod(recorder, 0o755)
  return exec(process.execPath, [cli, ...args], {
    cwd: scratch,
    env: {
      ...process.env,
      TED_HOME: home,
      TED_RUN: 'run-1',
      TED_TASK: 'task-1',
      TED_GH_BIN: recorder,
    },
  })
}

async function openHome() {
  daemon = await startDaemon({
    home,
    version: tedVersion,
    checkAgentsOnStart: false,
    integrations: { checkOnStart: false, loginShell: false },
    disk: { excludeFromBackups: async () => undefined },
  })
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('no daemon.json')
  return new DaemonClient(info, '', { appKey: daemon.appToken })
}

test('adds a Factory from a local repo inside a Run without GitHub or repo commands', async () => {
  const folder = await makeSourceRepo()

  const added = await ted('dev', 'factory', 'add', 'widgets', '--key', 'WG')
  expect(added.stdout).toContain('Added Factory WG (local/widgets)')

  await writeFile(path.join(folder, 'NOTES.md'), 'later\n')
  await git(folder, 'add', '.')
  await git(folder, 'commit', '-m', 'second')
  const again = await ted('dev', 'factory', 'add', folder, '--key', 'WG')
  expect(again.stdout).toContain('Updated WG’s copy of local/widgets')

  expect(await readdir(markers)).toEqual([])
  const client = await openHome()
  expect(await client.listFactories()).toMatchObject([
    { key: 'WG', repo: 'local/widgets', defaultBranch: 'main', cloned: true, hasSettings: true },
  ])
}, 90_000)

test('refuses the Ted homes, a folder that isn’t a repo’s top and a home whose daemon runs', async () => {
  const folder = await makeSourceRepo()
  const tedDevHome = path.join(homedir(), '.ted-dev')
  await expect(
    exec(process.execPath, [cli, 'dev', 'factory', 'add', folder, '--key', 'WG'], {
      env: { ...process.env, TED_HOME: tedDevHome },
    }),
  ).rejects.toMatchObject({ stderr: expect.stringContaining('Choose a separate TED_HOME') })

  await expect(
    ted('dev', 'factory', 'add', path.join(folder, '.ted'), '--key', 'WG'),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining('isn’t the top folder of a git repo'),
  })

  await openHome()
  await expect(ted('dev', 'factory', 'add', folder, '--key', 'WG')).rejects.toMatchObject({
    stderr: expect.stringContaining('Quit it first'),
  })
  expect(await readdir(markers)).toEqual([])
}, 90_000)
