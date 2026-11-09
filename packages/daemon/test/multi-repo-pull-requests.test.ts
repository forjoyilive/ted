import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { TaskRepo } from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { Gh } from '../src/github/gh.ts'
import type { TedStore } from '../src/store/index.ts'
import { createPullRequests, type PullRequestTarget } from '../src/tasks/pull-requests.ts'

const run = promisify(execFile)
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-multi-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function repoWith(name: string, commits: number): Promise<PullRequestTarget> {
  const origin = path.join(dir, `${name}.git`)
  const seed = path.join(dir, `${name}-seed`)
  const worktree = path.join(dir, name)
  await mkdir(origin)
  await run('git', ['init', '--bare', '--initial-branch=main'], { cwd: origin })
  await mkdir(seed)
  await run('git', ['init', '--initial-branch=main'], { cwd: seed })
  await writeFile(path.join(seed, 'README.md'), name)
  await run('git', ['add', '-A'], { cwd: seed, env })
  await run('git', ['commit', '-m', 'first'], { cwd: seed, env })
  await run('git', ['push', origin, 'main'], { cwd: seed, env })
  await run('git', ['clone', origin, worktree], { cwd: dir, env })
  await run('git', ['checkout', '-b', 'ted/nb-1-notes'], { cwd: worktree, env })
  for (let i = 0; i < commits; i++) {
    await writeFile(path.join(worktree, `work-${i}.txt`), String(i))
    await run('git', ['add', '-A'], { cwd: worktree, env })
    await run('git', ['commit', '-m', `work ${i}`], { cwd: worktree, env })
  }
  return {
    name,
    repo: `acme/${name}`,
    branch: 'ted/nb-1-notes',
    worktree,
    base: 'main',
    url: origin,
  }
}

function fakeStore(names: string[]) {
  const repos = new Map<string, TaskRepo>(
    names.map((name) => [
      name,
      {
        name,
        repo: `acme/${name}`,
        branch: 'ted/nb-1-notes',
        worktree: '',
        copied: [],
        skipped: [],
      },
    ]),
  )
  const change = (name: string, fields: Partial<TaskRepo>) => {
    const repo = repos.get(name)
    if (repo) repos.set(name, { ...repo, ...fields })
  }
  const store = {
    getTask: () => ({ repos: [...repos.values()] }),
    branchPushed: (_: string, name: string, push: Omit<NonNullable<TaskRepo['pushed']>, 'at'>) =>
      change(name, { pushed: { ...push, at: 'now' } }),
    branchPushFailed: (_: string, name: string, message: string) =>
      change(name, { pushFailed: { message, at: 'now' } }),
    pullRequestOpened: (
      _: string,
      name: string,
      pr: { number: number; url: string; base: string },
    ) => change(name, { pullRequest: { ...pr, state: 'draft' } }),
    pullRequestMarkedReady: (_: string, name: string) => {
      const pr = repos.get(name)?.pullRequest
      if (pr) change(name, { pullRequest: { ...pr, state: 'ready' } })
    },
    pullRequestClosed: () => undefined,
  }
  return { store: store as unknown as TedStore, repos }
}

function fakeGh() {
  const calls: { args: readonly string[]; input?: string }[] = []
  let next = 10
  const gh: Gh = {
    async run(args, options) {
      calls.push({ args, ...(options?.input !== undefined && { input: options.input }) })
      if (args[1] === 'create') {
        const repo = args[args.indexOf('--repo') + 1]
        return `https://github.com/${repo}/pull/${next++}\n`
      }
      return ''
    },
    api: async () => {
      throw new Error('not found')
    },
    graphql: async () => {
      throw new Error('not found')
    },
  }
  return { gh, calls }
}

test('a multi-repo Task gets one draft pull request per repo with commits, each linking the others', async () => {
  const targets = [await repoWith('api', 1), await repoWith('web', 2), await repoWith('docs', 0)]
  const { store, repos } = fakeStore(['api', 'web', 'docs'])
  const { gh, calls } = fakeGh()
  const prs = createPullRequests({ store, gh })
  const task = { id: 't', displayId: 'NB-1', title: 'Offline notes', goal: 'Edit notes offline.' }

  await prs.push(task, targets, 'first')

  expect(repos.get('api')?.pullRequest).toMatchObject({ number: 10, state: 'draft' })
  expect(repos.get('web')?.pullRequest).toMatchObject({ number: 11, state: 'draft' })
  expect(repos.get('docs')?.pullRequest).toBeUndefined()
  expect(repos.get('docs')?.pushed).toBeUndefined()
  expect(calls.filter((c) => c.args[1] === 'create')).toHaveLength(2)

  const edits = calls.filter((c) => c.args[1] === 'edit')
  expect(edits.map((c) => [c.args[2], c.args[4]])).toEqual([
    ['10', 'acme/api'],
    ['11', 'acme/web'],
  ])
  expect(edits[0]?.input).toContain('acme/web#11')
  expect(edits[0]?.input).not.toContain('acme/docs')
  expect(edits[1]?.input).toContain('acme/api#10')
  expect(edits[1]?.input).toContain('Edit notes offline.')

  await prs.push(task, targets, 'again')
  expect(calls.filter((c) => c.args[1] === 'create')).toHaveLength(2)

  await prs.ready(task, targets)
  expect(calls.filter((c) => c.args[1] === 'ready').map((c) => c.args.slice(2))).toEqual([
    ['10', '--repo', 'acme/api'],
    ['11', '--repo', 'acme/web'],
  ])
})

test('a draft whose latest commits can’t be pushed stays a draft at sign-off', async () => {
  const targets = [await repoWith('api', 1), await repoWith('web', 1)]
  const { store, repos } = fakeStore(['api', 'web'])
  const { gh, calls } = fakeGh()
  const prs = createPullRequests({ store, gh })
  const task = { id: 't', displayId: 'NB-1', title: 'Offline notes' }
  await prs.push(task, targets, 'first')

  await writeFile(path.join(dir, 'api.git', 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', {
    mode: 0o755,
  })
  const api = targets[0]?.worktree ?? ''
  await writeFile(path.join(api, 'later.txt'), 'later')
  await run('git', ['add', '-A'], { cwd: api, env })
  await run('git', ['commit', '-m', 'later'], { cwd: api, env })

  await prs.ready(task, targets)
  expect(calls.filter((c) => c.args[1] === 'ready').map((c) => c.args[4])).toEqual(['acme/web'])
  expect(repos.get('api')?.pullRequest?.state).toBe('draft')
  expect(repos.get('api')?.pushFailed?.message).toContain('git push failed')
  expect(repos.get('web')?.pullRequest?.state).toBe('ready')
})

test('TED pushes to the Factory’s URL and ignores the repo’s own git config', async () => {
  const api = await repoWith('api', 1)
  const marker = path.join(dir, 'ran')
  const elsewhere = path.join(dir, 'elsewhere.git')
  const hooks = path.join(dir, 'agent-hooks')
  const touch = `#!/bin/sh\ntouch '${marker}'\n`
  await mkdir(hooks)
  await writeFile(path.join(hooks, 'pre-push'), touch, { mode: 0o755 })
  await writeFile(path.join(api.worktree, '.git', 'hooks', 'pre-push'), touch, { mode: 0o755 })
  const fsmonitor = path.join(dir, 'fsmonitor.sh')
  await writeFile(fsmonitor, touch, { mode: 0o755 })
  const config = (key: string, value: string) =>
    run('git', ['config', key, value], { cwd: api.worktree })
  await config('remote.origin.url', elsewhere)
  await config('remote.origin.pushurl', elsewhere)
  await config('remote.origin.receivepack', `touch '${marker}'; git-receive-pack`)
  await config(`url.${elsewhere}.pushInsteadOf`, path.join(dir, 'api.git'))
  await config('core.hooksPath', hooks)
  await config('core.fsmonitor', fsmonitor)
  await config('core.sshCommand', `touch '${marker}'`)
  await config('credential.helper', `!touch '${marker}'`)
  await config('http.proxy', 'http://127.0.0.1:9')
  await config('http.extraHeader', 'Authorization: Bearer leaked')
  await config('protocol.ext.allow', 'always')
  const { store, repos } = fakeStore(['api'])
  const { gh } = fakeGh()
  const prs = createPullRequests({ store, gh })

  await prs.push({ id: 't', displayId: 'NB-1', title: 'Offline notes' }, [api], 'first')

  expect(repos.get('api')?.pushFailed).toBeUndefined()
  expect(repos.get('api')?.pullRequest?.state).toBe('draft')
  const pushed = await run('git', ['rev-parse', 'refs/heads/ted/nb-1-notes'], {
    cwd: path.join(dir, 'api.git'),
  })
  expect(pushed.stdout.trim()).toBe(repos.get('api')?.pushed?.commit)
  await expect(run('git', ['--git-dir', elsewhere, 'rev-parse', 'HEAD'])).rejects.toThrow()
  await expect(run('test', ['-e', marker])).rejects.toThrow()
})
