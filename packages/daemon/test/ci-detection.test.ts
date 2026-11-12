import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { detectCi } from '../src/tasks/pull-requests.ts'

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
  detectCi({ gh, repo: 'acme/widgets', base: 'main', worktree: dir, commit: sha })

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-ci-'))
  await run('git', ['init', '--initial-branch=main'], { cwd: dir })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const history = (rollups: unknown[]) => ({
  data: {
    repository: {
      ref: { target: { history: { nodes: rollups.map((r) => ({ statusCheckRollup: r })) } } },
    },
  },
})

describe('CI detection at push', () => {
  test('no workflow files, no required checks and no checks on base means no CI', async () => {
    const sha = await commit({ 'README.md': 'hi' })
    expect(await detect(silentGh({}, history([null, null])), sha)).toEqual({
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

  test('a workflow TED can’t read the triggers of counts', async () => {
    const broken = await commit({ '.github/workflows/ci.yml': 'on: [push\n' })
    expect((await detect(silentGh(), broken)).ci).toBe(true)
    const none = await commit({ '.github/workflows/ci.yml': 'jobs: {}\n' })
    expect((await detect(silentGh(), none)).ci).toBe(true)
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

  test('a check run or status on one of the last 20 base commits means CI', async () => {
    const sha = await commit({ 'README.md': 'hi' })
    const gh = silentGh({}, history([null, { state: 'SUCCESS' }, null]))
    expect(await detect(gh, sha)).toEqual({ ci: true, ciSignals: ['recent-checks'] })
  })
})
