import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { CiSignal } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { lastCiFound } from '../src/factory-settings.ts'
import { expectsCi } from '../src/tasks/merge.ts'
import { detectCi } from '../src/tasks/pull-requests.ts'
import { filterMatches, runsOnChanges } from '../src/tasks/workflow-triggers.ts'

const run = promisify(execFile)
let dir: string

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

async function commit(files: Record<string, string>): Promise<string> {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true })
    await writeFile(path.join(dir, file), content)
  }
  await run('git', ['add', '-A'], { cwd: dir, env })
  await run('git', ['commit', '-m', 'c'], { cwd: dir, env })
  return (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()
}

const silentGh = (paths: Record<string, unknown> = {}, graphql?: unknown) => ({
  api: async (route: string) => {
    if (route in paths) return paths[route]
    throw new Error('gh api failed: Not Found (HTTP 404)')
  },
  graphql: async () => {
    if (graphql === undefined) throw new Error('gh api failed')
    return graphql
  },
})

const detect = (gh: ReturnType<typeof silentGh>, sha: string) =>
  detectCi({
    gh,
    repo: 'acme/widgets',
    base: 'main',
    branch: 'ted/nb-1',
    worktree: dir,
    commit: sha,
  })

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-ci-'))
  await run('git', ['init', '--initial-branch=main'], { cwd: dir })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const pulls = (rows: { head: string; rollup: unknown }[]) => ({
  data: {
    repository: {
      pullRequests: {
        nodes: rows.map((r) => ({
          headRefName: r.head,
          commits: { nodes: [{ commit: { statusCheckRollup: r.rollup } }] },
        })),
      },
    },
  },
})

describe('CI detection at push', () => {
  test('no workflow files, no required checks and no checks on pull requests means no CI', async () => {
    const sha = await commit({ 'README.md': 'hi' })
    const gh = silentGh({}, pulls([{ head: 'fix-a', rollup: null }]))
    expect(await detect(gh, sha)).toEqual({
      ci: false,
      ciSignals: [],
    })
  })

  test('a workflow file on the branch means CI', async () => {
    const sha = await commit({ '.github/workflows/ci.yml': 'on: push' })
    expect(await detect(silentGh(), sha)).toEqual({ ci: true, ciSignals: ['workflow-files'] })
  })

  test('a workflow that runs only by hand, on a schedule or on a release doesn’t count', async () => {
    const manual = await commit({
      '.github/workflows/release.yml': 'on:\n  workflow_dispatch:\n',
      '.github/workflows/nightly.yml': 'on: [schedule, release]\n',
      '.github/workflows/call.yaml': 'on: workflow_call\n',
    })
    expect((await detect(silentGh(), manual)).ci).toBe(false)
    const withPullRequest = await commit({
      '.github/workflows/ci.yml': 'on:\n  workflow_dispatch:\n  pull_request:\n',
    })
    expect((await detect(silentGh(), withPullRequest)).ciSignals).toEqual(['workflow-files'])
  })

  test('a workflow Ted can’t read the triggers of counts', async () => {
    const broken = await commit({ '.github/workflows/ci.yml': 'on: [push\n' })
    expect((await detect(silentGh(), broken)).ci).toBe(true)
    const none = await commit({ '.github/workflows/ci.yml': 'jobs: {}\n' })
    expect((await detect(silentGh(), none)).ci).toBe(true)
    const odd = await commit({ '.github/workflows/ci.yml': 'on: [{toString: null}]\n' })
    expect((await detect(silentGh(), odd)).ci).toBe(true)
  })

  test('a non-YAML file in .github/workflows doesn’t count', async () => {
    const sha = await commit({ '.github/workflows/README.md': 'notes' })
    expect((await detect(silentGh(), sha)).ci).toBe(false)
  })

  test('required status checks on the base branch mean CI, from protection or rulesets', async () => {
    const sha = await commit({ 'README.md': 'hi' })
    const protectedBase = silentGh({
      'repos/acme/widgets/branches/main': {
        protection: { required_status_checks: { contexts: ['build'], checks: [] } },
      },
    })
    expect(await detect(protectedBase, sha)).toEqual({ ci: true, ciSignals: ['required-checks'] })
    const ruleset = silentGh({
      'repos/acme/widgets/rules/branches/main': [{ type: 'required_status_checks' }],
    })
    expect(await detect(ruleset, sha)).toEqual({ ci: true, ciSignals: ['required-checks'] })
    const noneRequired = silentGh({
      'repos/acme/widgets/branches/main': {
        protection: { required_status_checks: { contexts: [], checks: [] } },
      },
      'repos/acme/widgets/rules/branches/main': [{ type: 'deletion' }],
    })
    expect((await detect(noneRequired, sha)).ci).toBe(false)
  })

  test('checks on a recent pull request mean CI, but not on this Task’s own pull request', async () => {
    const sha = await commit({ 'README.md': 'hi' })
    const other = silentGh(
      {},
      pulls([
        { head: 'fix-a', rollup: null },
        { head: 'fix-b', rollup: { state: 'SUCCESS' } },
      ]),
    )
    expect(await detect(other, sha)).toEqual({ ci: true, ciSignals: ['recent-pull-requests'] })
    const own = silentGh({}, pulls([{ head: 'ted/nb-1', rollup: { state: 'PENDING' } }]))
    expect((await detect(own, sha)).ci).toBe(false)
  })

  test('a workflow limited to other branches doesn’t count', async () => {
    const mainOnly = await commit({
      '.github/workflows/deploy.yml': 'on:\n  push:\n    branches: [main]\n',
      '.github/workflows/release.yml': 'on:\n  push:\n    tags: [v*]\n',
      '.github/workflows/pr.yml': 'on:\n  pull_request:\n    branches: [release/**]\n',
    })
    expect((await detect(silentGh(), mainOnly)).ci).toBe(false)
    const tedBranches = await commit({
      '.github/workflows/ci.yml': 'on:\n  push:\n    branches: [main, "ted/**"]\n',
    })
    expect((await detect(silentGh(), tedBranches)).ciSignals).toEqual(['workflow-files'])
  })
})

describe('workflow triggers', () => {
  const pushed = { branch: 'ted/nb-1', base: 'main' }

  test('push filters match the Task branch and pull request filters match the base', () => {
    expect(runsOnChanges('on:\n  push:\n    branches-ignore: [main]\n', pushed)).toBe(true)
    expect(runsOnChanges('on:\n  push:\n    branches-ignore: ["ted/*"]\n', pushed)).toBe(false)
    expect(runsOnChanges('on:\n  pull_request:\n    branches: [main]\n', pushed)).toBe(true)
    expect(runsOnChanges('on:\n  pull_request_target:\n    branches: [dev]\n', pushed)).toBe(false)
    expect(runsOnChanges('on:\n  push:\n    paths: [src/**]\n', pushed)).toBe(true)
    const closedOnly = 'on:\n  pull_request:\n    types: [closed]\n    branches: [main]\n'
    expect(runsOnChanges(closedOnly, pushed)).toBe(false)
    const opened = 'on:\n  pull_request_target:\n    types: [opened, synchronize]\n'
    expect(runsOnChanges(opened, pushed)).toBe(true)
    expect(runsOnChanges('on:\n  pull_request:\n    types: 7\n', pushed)).toBe(true)
    expect(runsOnChanges('on:\n  push:\n    branches: ["**", "!ted/**"]\n', pushed)).toBe(false)
    expect(runsOnChanges('on:\n  push:\n    branches: 7\n', pushed)).toBe(true)
    const crafted = `"${'*a'.repeat(20)}"`
    expect(runsOnChanges(`on:\n  push:\n    branches-ignore: [${crafted}]\n`, pushed)).toBe(true)
    expect(
      runsOnChanges(`on:\n  push:\n    branches: ["**", "!${'*a'.repeat(20)}"]\n`, pushed),
    ).toBe(true)
  })

  test('branch patterns follow GitHub’s filter syntax', () => {
    expect(filterMatches('ted/*', 'ted/nb-1')).toBe(true)
    expect(filterMatches('*', 'ted/nb-1')).toBe(false)
    expect(filterMatches('**', 'ted/nb-1')).toBe(true)
    expect(filterMatches('release/v[0-9].x', 'release/v2.x')).toBe(true)
    expect(filterMatches('feature.x', 'featureAx')).toBe(false)
    expect(filterMatches(`${'*a'.repeat(20)}b`, 'a'.repeat(60))).toBeUndefined()
    expect(filterMatches('x'.repeat(201), 'ted/nb-1')).toBeUndefined()
  })
})

describe('Pull request CI setting', () => {
  const push = (ciSignals: CiSignal[]) => ({
    commit: 'abc',
    at: '2026-11-16T10:00:00.000Z',
    ci: ciSignals.length > 0,
    ciSignals,
  })

  test('none and required override detection, except a required check', () => {
    expect(expectsCi(undefined, push(['recent-pull-requests']))).toBe(true)
    expect(expectsCi('auto', push([]))).toBe(false)
    expect(expectsCi(undefined, undefined)).toBe(true)
    expect(expectsCi('none', push(['workflow-files', 'recent-pull-requests']))).toBe(false)
    expect(expectsCi('none', push(['required-checks']))).toBe(true)
    expect(expectsCi('required', push([]))).toBe(true)
  })

  test('Factory settings show the newest push to the repo', () => {
    const task = (displayId: string, repo: string, at: string, ciSignals: CiSignal[]) => ({
      displayId,
      repos: [{ repo, pushed: { ...push(ciSignals), at } }],
    })
    const tasks = [
      task('NB-1', 'acme/widgets', '2026-11-16T09:00:00.000Z', ['workflow-files']),
      task('NB-2', 'Acme/Widgets', '2026-11-16T11:00:00.000Z', []),
      task('NB-3', 'acme/other', '2026-11-16T12:00:00.000Z', ['required-checks']),
    ]
    expect(lastCiFound(tasks, 'acme/widgets')).toEqual({
      signals: [],
      task: 'NB-2',
      at: '2026-11-16T11:00:00.000Z',
    })
    expect(lastCiFound(tasks, 'acme/none')).toBeUndefined()
  })
})
