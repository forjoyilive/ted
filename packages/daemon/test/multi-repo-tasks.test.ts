import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  type Banner,
  type Factory,
  type Run,
  type RunSummary,
  type Task,
  type TaskReposResult,
  tedPaths,
} from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, expectTypeOf, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { openStore, type TedStore } from '../src/store/index.ts'
import type { MergeArea } from '../src/store/merge.ts'
import {
  api,
  assistantTexts,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'
import { skipInsideTedSandbox } from './support/ted-sandbox.ts'

expectTypeOf<TedStore>().toExtend<MergeArea>()

const execFileAsync = promisify(execFile)
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let daemon: RunningDaemon | undefined
const savedEnv = { ...process.env }

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'ted-multi-repo-')))
  origin = await makeOriginRepo(scratch)
  await makeSecondOrigin('api')
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = `url.file://${scratch}/.insteadOf`
  process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/'
  const ghState = path.join(scratch, 'gh.json')
  const info = (repo: string) => ({
    body: { full_name: repo, default_branch: 'main', permissions: { push: true } },
  })
  await writeFile(
    ghState,
    JSON.stringify({
      paths: {
        'repos/acme/api': info('acme/api'),
        'repos/acme/api/commits?per_page=1': { body: [] },
      },
    }),
  )
  process.env.TED_STUB_GH = ghState
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home, { waitForStart: true })
  process.env = { ...savedEnv }
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function makeSecondOrigin(name: string): Promise<void> {
  const bare = path.join(scratch, 'acme', `${name}.git`)
  const seed = path.join(scratch, `${name}-seed`)
  await mkdir(bare, { recursive: true })
  await execFileAsync('git', ['init', '--bare', '--initial-branch=main'], { cwd: bare })
  await mkdir(seed)
  await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: seed })
  await writeFile(path.join(seed, 'README.md'), `# ${name}\n`)
  await execFileAsync('git', ['add', '-A'], { cwd: seed, env: gitEnv })
  await execFileAsync('git', ['commit', '-m', 'first'], { cwd: seed, env: gitEnv })
  await execFileAsync('git', ['push', bare, 'main'], { cwd: seed, env: gitEnv })
}

const twoRepos = (apiWorktree = '') =>
  commitToOrigin(scratch, {
    '.ted/workflow.yaml': [
      'version: 1',
      'order: [intake, work, merge]',
      'repos:',
      '  - name: widgets',
      '  - name: api',
      '    remote: https://github.com/acme/api.git',
      apiWorktree,
    ].join('\n'),
  })

async function start(options: { home?: string } = {}) {
  daemon = await startDaemon({
    home: options.home ?? home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
  })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const call = async (method: string, route: string, body?: unknown) =>
    client.call(method, route, body)
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  return { ...client, call, ok }
}

type Client = Awaited<ReturnType<typeof start>>

async function addFactory(client: Client): Promise<Factory> {
  const added = await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  for (const banner of await client.ok<Banner[]>('GET', '/banners')) {
    if (banner.problem !== 'repo-in-workflow') continue
    await client.ok('POST', `/banners/${encodeURIComponent(banner.id)}/action`, {})
  }
  return added
}

const createTask = (client: Client, title: string) =>
  client.ok<Task>('POST', '/tasks', { title, factory: 'NB' })

const getTask = async (client: Client, id: string) =>
  (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })

const taskFolder = (id = 'NB-1') => path.join(home, 'worktrees', id)

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  )

const leadRun = (client: Client, task: Task): Promise<Run> =>
  waitUntil(async () => {
    const current = await getTask(client, task.id)
    return current?.leadRunId ? (await client.getRun(current.leadRunId)).run : undefined
  }, `${task.displayId}’s Task Lead Run`)

const firstMessage = async (client: Client, task: Task): Promise<string> => {
  const run = await leadRun(client, task)
  return waitUntil(async () => {
    const [first] = (await client.getRun(run.id)).conversation
    return first && (JSON.parse(first.line) as { message: { content: string } }).message.content
  }, 'the Task Lead’s first message')
}

const commandResults = async (client: Client, runId: string, count: number) =>
  waitUntil(async () => {
    const results = assistantTexts((await client.getRun(runId)).conversation).map(
      (text) => JSON.parse(text) as { code: number; stdout: string; stderr: string },
    )
    return results.length >= count ? results : undefined
  }, `${count} command results`)

const liveRepos = (task: Task | undefined) =>
  (task?.repos ?? []).filter((r) => !r.removed).map((r) => r.name)

describe('a multi-repo Task', () => {
  test('starts with only the primary repo’s worktree and runs in the Task folder', async () => {
    await twoRepos()
    const client = await start()
    await addFactory(client)
    const task = await createTask(client, steps({ run: ['pwd'] }, { endTurn: true }))
    expect(task.chosenRepos).toEqual(['acme/widgets'])

    await client.ok('POST', `/tasks/${task.id}/start`)

    const run = await leadRun(client, task)
    expect(run.cwd).toBe(taskFolder())
    const [pwd] = await commandResults(client, run.id, 1)
    expect(await realpath(pwd?.stdout.trim() ?? '')).toBe(await realpath(taskFolder()))
    expect(liveRepos(await getTask(client, task.id))).toEqual(['widgets'])
    expect(await exists(path.join(taskFolder(), 'widgets', 'README.md'))).toBe(true)
    expect(await exists(path.join(taskFolder(), 'api'))).toBe(false)
    const first = await firstMessage(client, task)
    expect(first).toContain('# Repos')
    expect(first).toContain('- api: acme/api')
    expect(first).toContain('ted task repos add')
  })

  test('the Task Lead adds a repo: same branch, setup runs, and the command prints its output', async () => {
    await twoRepos(
      ['    worktree:', '      setup: "echo installing api && touch setup-ran"', ''].join('\n'),
    )
    const client = await start()
    await addFactory(client)
    const task = await createTask(
      client,
      steps(
        { run: ['ted', 'task', 'repos', 'add', 'api'] },
        { run: ['git', '-C', 'api', 'branch', '--show-current'] },
        { endTurn: true },
      ),
    )
    await client.ok('POST', `/tasks/${task.id}/start`)
    const run = await leadRun(client, task)

    const [added, branch] = await commandResults(client, run.id, 2)
    expect(added?.code).toBe(0)
    expect(added?.stdout).toContain(`Added api at ${path.join(taskFolder(), 'api')}.`)
    expect(added?.stdout).toContain('Its setup, `echo installing api && touch setup-ran`, passed.')
    expect(added?.stdout).toContain('installing api')
    expect(added?.stdout).toContain('NB-1’s repos: widgets, api')
    expect(await exists(path.join(taskFolder(), 'api', 'setup-ran'))).toBe(true)
    const current = await getTask(client, task.id)
    expect(branch?.stdout.trim()).toBe(current?.branch)
    expect(liveRepos(current)).toEqual(['widgets', 'api'])
    expect(current?.chosenRepos).toEqual(['acme/widgets', 'acme/api'])
    const lines = await client.ok<{ text: string }[]>('GET', `/tasks/${task.id}/events`)
    expect(lines.map((l) => l.text)).toContain('Task Lead set Repos to widgets, api')
    expect(lines.filter((line) => line.text.startsWith('Setting up api ·'))).toHaveLength(1)
    expect(lines.filter((line) => line.text === 'Setup finished in api')).toHaveLength(1)
  })

  test('removing a repo whose worktree has commits waits for --yes, then removes the worktree', async () => {
    await twoRepos()
    const client = await start()
    await addFactory(client)
    const commit = [
      'git',
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-C',
      'api',
      'commit',
      '--allow-empty',
      '-m',
      'api work',
    ]
    const task = await createTask(
      client,
      steps(
        { run: ['ted', 'task', 'repos', 'set', 'widgets', 'api'] },
        { run: commit },
        { run: ['ted', 'task', 'repos', 'remove', 'api'] },
        { run: ['ted', 'task', 'repos', 'remove', 'api', '--yes'] },
        { endTurn: true },
      ),
    )
    await client.ok('POST', `/tasks/${task.id}/start`)
    const run = await leadRun(client, task)

    const results = await commandResults(client, run.id, 4)
    expect(results[1]?.code).toBe(0)
    expect(results[2]?.code).toBe(1)
    expect(results[2]?.stderr).toContain('api’s worktree has 1 commit that would be lost')
    expect(results[3]?.code).toBe(0)
    expect(results[3]?.stdout).toContain('Removed api; its worktree is gone.')
    expect(await exists(path.join(taskFolder(), 'api'))).toBe(false)
    expect(liveRepos(await getTask(client, task.id))).toEqual(['widgets'])
  })

  test.runIf(process.platform === 'darwin')(
    'a Run cannot escape through an edited teardown script when removing a repo',
    async (context) => {
      skipInsideTedSandbox(context)
      await twoRepos(['    worktree:', '      teardown: "sh cleanup.sh"', ''].join('\n'))
      const client = await start()
      await addFactory(client)
      const marker = path.join(home, 'escaped')
      const task = await createTask(
        client,
        steps(
          { run: ['ted', 'task', 'repos', 'set', 'widgets', 'api'] },
          { run: ['sh', '-c', `echo "echo escaped > '${marker}'" > api/cleanup.sh`] },
          { run: ['ted', 'task', 'repos', 'remove', 'api'] },
          { endTurn: true },
        ),
      )
      await client.ok('POST', `/tasks/${task.id}/start`)
      const run = await leadRun(client, task)
      const results = await commandResults(client, run.id, 3)
      expect(results.map((r) => r.code)).toEqual([0, 0, 0])
      expect(await exists(marker)).toBe(false)
      expect(await exists(path.join(taskFolder(), 'api'))).toBe(false)
      const current = await getTask(client, task.id)
      expect(current?.repos.find((r) => r.name === 'api')?.removed?.teardown?.outcome).toBe(
        'failed',
      )
      const output = await readFile(
        path.join(home, 'logs', 'worktrees', 'NB-1-api-teardown.log'),
        'utf8',
      )
      expect(output).toContain('Operation not permitted')
    },
  )

  test('the human sets Repos in Backlog; both worktrees and setups are ready before the Task Lead', async () => {
    await twoRepos(['    worktree:', '      setup: "touch setup-ran"', ''].join('\n'))
    const client = await start()
    await addFactory(client)
    const task = await createTask(client, steps({ run: ['ls', 'api'] }, { endTurn: true }))

    const set = await client.ok<TaskReposResult>('PUT', `/tasks/${task.id}/repos`, {
      set: ['acme/widgets', 'acme/api'],
    })
    expect(set.repos).toEqual(['widgets', 'api'])
    expect(set.task.chosenRepos).toEqual(['acme/widgets', 'acme/api'])
    expect(set.task.repos).toEqual([])

    await client.ok('POST', `/tasks/${task.id}/start`)
    const run = await leadRun(client, task)
    const [ls] = await commandResults(client, run.id, 1)
    expect(ls?.stdout.split('\n')).toContain('setup-ran')
    const current = await getTask(client, task.id)
    expect(liveRepos(current)).toEqual(['widgets', 'api'])
    expect(new Set(current?.repos.map((r) => r.branch)).size).toBe(1)
  })

  test('the human adds a repo while the Task Lead works, and the Task Lead is told', async () => {
    await twoRepos()
    const client = await start()
    await addFactory(client)
    const task = await createTask(
      client,
      steps({ endTurn: true }, { everyMessage: [{ say: 'ok' }, { endTurn: true }] }),
    )
    await client.ok('POST', `/tasks/${task.id}/start`)
    const run = await leadRun(client, task)
    await waitUntil(async () => (await client.getRun(run.id)).run.state === 'idle', 'idle Lead')

    const added = await client.ok<TaskReposResult>('PUT', `/tasks/${task.id}/repos`, {
      add: ['api'],
    })
    expect(added.added).toEqual(['api'])
    expect(await exists(path.join(taskFolder(), 'api', 'README.md'))).toBe(true)
    const told = await waitUntil(async () => {
      const lines = (await client.getRun(run.id)).conversation.map((e) => e.line)
      return lines.find((l) => l.includes('The human changed this Task’s repos'))
    }, 'the message to the Task Lead')
    expect(told).toContain('Added api (acme/api)')
    const lines = await client.ok<{ text: string }[]>('GET', `/tasks/${task.id}/events`)
    expect(lines.map((l) => l.text)).toContain('You set Repos to widgets, api')
  })

  test('refusals: unknown repo, no repos left, an open pull request, and Done', async () => {
    await twoRepos()
    const client = await start()
    await addFactory(client)
    const task = await createTask(client, steps({ endTurn: true }))

    const unknown = await client.call('PUT', `/tasks/${task.id}/repos`, { add: ['web'] })
    expect(unknown.status).toBe(400)
    expect(JSON.stringify(unknown.body)).toContain('its repos are widgets, api')
    const none = await client.call('PUT', `/tasks/${task.id}/repos`, { remove: ['widgets'] })
    expect(none.status).toBe(400)
    expect(JSON.stringify(none.body)).toContain('a Task needs at least one repo')
    const both = await client.call('PUT', `/tasks/${task.id}/repos`, { set: [], add: ['api'] })
    expect(both.status).toBe(400)

    await client.ok('PUT', `/tasks/${task.id}/repos`, { set: ['widgets', 'api'] })
    await client.ok('POST', `/tasks/${task.id}/start`)
    await leadRun(client, task)
    await waitUntil(
      async () => liveRepos(await getTask(client, task.id)).length === 2,
      'two worktrees',
    )
    await daemon?.stop()
    daemon = undefined
    const store = await openStore({ directory: tedPaths(home).store })
    store.pullRequestOpened(task.id, 'api', {
      number: 7,
      url: 'https://github.com/acme/api/pull/7',
      base: 'main',
    })
    await store.close()

    const again = await start()
    const open = await again.call('PUT', `/tasks/${task.id}/repos`, { remove: ['api'] })
    expect(open.status).toBe(409)
    expect(JSON.stringify(open.body)).toContain('api has an open pull request (#7)')
  })

  test('archiving removes every repo’s worktree after its teardown; Unarchive makes them all again', async () => {
    await twoRepos(
      [
        '    worktree:',
        '      teardown: "echo torn-down"',
        '      setup: "touch setup-ran"',
        '',
      ].join('\n'),
    )
    const client = await start()
    await addFactory(client)
    const commit = [
      'git',
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-C',
      'api',
      'commit',
      '--allow-empty',
      '-m',
      'api work',
    ]
    const task = await createTask(
      client,
      steps({ run: commit }, { endTurn: true }, { everyMessage: [{ endTurn: true }] }),
    )
    await client.ok('PUT', `/tasks/${task.id}/repos`, { set: ['widgets', 'api'] })
    await client.ok('POST', `/tasks/${task.id}/start`)
    const run = await leadRun(client, task)
    await commandResults(client, run.id, 1)

    await client.ok('POST', `/tasks/${task.id}/archive`, {})

    await waitUntil(async () => !(await exists(taskFolder())), 'the Task folder to go')
    expect(
      await readFile(path.join(home, 'logs', 'worktrees', 'NB-1-api-teardown.log'), 'utf8'),
    ).toBe('torn-down\n')
    const archived = await waitUntil(async () => {
      const current = await getTask(client, task.id)
      return current?.repos.every((r) => r.removed !== undefined) ? current : undefined
    }, 'every repo to be recorded as removed')
    expect(archived?.repos.find((r) => r.name === 'api')?.removed?.teardown?.outcome).toBe('passed')

    await client.ok('POST', `/tasks/${task.id}/unarchive`)

    const back = await waitUntil(async () => {
      const current = await getTask(client, task.id)
      return liveRepos(current).length === 2 && current?.leadRunId !== run.id ? current : undefined
    }, 'both worktrees again')
    expect(liveRepos(back)).toEqual(['widgets', 'api'])
    expect(new Set(back?.repos.filter((r) => !r.removed).map((r) => r.branch))).toEqual(
      new Set([archived?.branch]),
    )
    await waitUntil(
      () => exists(path.join(taskFolder(), 'api', 'setup-ran')),
      'api’s setup to run again',
    )
    const { stdout } = await execFileAsync('git', ['log', '--format=%s', '-1'], {
      cwd: path.join(taskFolder(), 'api'),
    })
    expect(stdout.trim()).toBe('api work')
  })
})

describe('Validate rounds in a multi-repo Factory', () => {
  test('a repo removed since the last review makes the next round a full review', async () => {
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml': [
        'version: 1',
        'order: [intake, work, validate, review, merge]',
        'reviewer: { agent: same }',
        'repos:',
        '  - name: widgets',
        '  - name: api',
        '    remote: https://github.com/acme/api.git',
        'stages:',
        '  validate: { max_back: 5, loop_check: false, p1_only_from: false }',
        '',
      ].join('\n'),
    })
    const client = await start()
    await addFactory(client)
    const prompt = path.join(scratch, 'review.md')
    await writeFile(
      prompt,
      `# Review the whole branch\n\n${steps({ say: 'Reviewed' }, { endTurn: true })}\n`,
    )
    const findings = path.join(scratch, 'findings.md')
    await writeFile(findings, '1. The export button does nothing.\n')
    const count = path.join(scratch, 'lead-messages')
    const review = `out=$(ted run start --reviewer --prompt-file "${prompt}"); ted run wait "$(echo "$out" | grep -o "[0-9a-f]\\{6\\}" | head -1)";`
    const each = {
      run: [
        'sh',
        '-c',
        [
          `n=$(cat "${count}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${count}";`,
          'case $n in',
          '1) ted task repos set widgets api; ted outcome advance;;',
          '2) ted outcome advance;;',
          `3) ${review} ted outcome back --to work --findings "${findings}";;`,
          '4) ted task repos remove api --yes; ted outcome advance;;',
          `5) ${review} ted outcome advance;;`,
          'esac',
        ].join(' '),
      ],
    }
    const task = await createTask(
      client,
      steps({ everyMessage: [each, { endTurn: true }] }, each, { endTurn: true }),
    )
    await client.ok('POST', `/tasks/${task.id}/start`)
    await waitUntil(
      async () => (await getTask(client, task.id))?.stage === 'review' || undefined,
      'the Task to reach Review',
      90_000,
    )

    const userMessages = async (runId: string) =>
      (await client.getRun(runId)).conversation.flatMap((e) => {
        const line = JSON.parse(e.line) as { type: string; message?: { content?: unknown } }
        return line.type === 'user' && typeof line.message?.content === 'string'
          ? [line.message.content]
          : []
      })
    const reviewers = (await client.ok<RunSummary[]>('GET', `/tasks/${task.id}/runs`))
      .filter((r) => r.name === 'Reviewer · Validate')
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    expect(reviewers).toHaveLength(2)
    const second = (await userMessages(reviewers[1]?.id ?? ''))[0] ?? ''
    expect(second).toContain('# Your instructions from the Task Lead of NB-1')
    expect(second).not.toContain('Ted set the scope of this review')
    const lead = (await getTask(client, task.id))?.leadRunId ?? ''
    const round = (await userMessages(lead)).find((m) => m.includes('# Validate round 2'))
    expect(round).toContain('this round reviews the whole change again')
    expect(round).not.toContain('This round checks the fixes.')
  }, 150_000)
})

describe('a single-repo Factory', () => {
  test('has no Repos to change and runs in the repo’s worktree', async () => {
    const client = await start()
    await addFactory(client)
    const task = await createTask(client, steps({ endTurn: true }))
    expect(task.chosenRepos).toEqual(['acme/widgets'])

    const refused = await client.call('PUT', `/tasks/${task.id}/repos`, { add: ['api'] })
    expect(refused.status).toBe(409)

    await client.ok('POST', `/tasks/${task.id}/start`)
    const run = await leadRun(client, task)
    expect(run.cwd).toBe(path.join(taskFolder(), 'widgets'))
    expect(await firstMessage(client, task)).not.toContain('# Repos')
    expect(await readFile(path.join(run.cwd, 'README.md'), 'utf8')).toBe('# widgets\n')
  })
})
