import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Comment, Factory, RunSlots, RunSummary, Task } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  assistantTexts,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  stubCodexPath,
  tokenFor,
  waitUntil,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-origin-'))
  await makeOriginRepo(scratch)
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function startTed() {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    codexBin: stubCodexPath,
  })
  const client = api(daemon.port, await tokenFor(home))
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  await ok<Factory>('POST', '/dev/factories', {
    repo: path.join(scratch, 'acme', 'widgets.git'),
    key: 'NB',
  })
  return { ...client, ok }
}

type Client = Awaited<ReturnType<typeof startTed>>

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })

const getTask = async (client: Client, id: string) => {
  const task = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)
  if (!task) throw new Error(`no Task ${id}`)
  return task
}

async function startTask(client: Client, title: string): Promise<Task> {
  const task = await client.ok<Task>('POST', '/tasks', { title, factory: 'NB' })
  return client.ok<Task>('POST', `/tasks/${task.id}/start`)
}

async function promptFile(name: string, heading: string | undefined, ...list: unknown[]) {
  const file = path.join(scratch, name)
  await writeFile(file, [...(heading ? [`# ${heading}`, ''] : []), steps(...list), ''].join('\n'))
  return file
}

const leadSaid = async (client: Client, task: Task) => {
  const current = await getTask(client, task.id)
  const run = current.leadRunId
  if (!run) return []
  const { conversation } = await client.ok<{ conversation: never[] }>('GET', `/runs/${run}`)
  return assistantTexts(conversation)
}

const toolResults = async (client: Client, task: Task) =>
  (await leadSaid(client, task)).flatMap((text) => {
    try {
      const parsed = JSON.parse(text) as { code: number; stdout: string; stderr: string }
      return typeof parsed.code === 'number' ? [parsed] : []
    } catch {
      return []
    }
  })

const waitForResults = (client: Client, task: Task, count: number) =>
  waitUntil(async () => {
    const results = await toolResults(client, task)
    return results.length >= count ? results : undefined
  }, `the Task Lead to finish ${count} commands`)

const runIdOf = 'grep -o "[0-9a-f-]\\{36\\}" | head -1'

const startAndWait = (args: string) =>
  `out=$(ted run start ${args}) || exit $?; echo "$out" | head -1; ted run wait "$(echo "$out" | ${runIdOf})"`

describe('sub-agents', () => {
  test('the Task Lead starts a sub-agent and waits for its final message', async () => {
    const client = await startTed()
    const prompt = await promptFile(
      'explore.md',
      'Explore the parser',
      { say: 'Looking around' },
      { say: 'The parser lives in src/parse.ts' },
      { endTurn: true },
    )
    const task = await startTask(
      client,
      steps(
        { run: ['sh', '-c', startAndWait(`--agent claude --prompt-file ${prompt}`)] },
        { endTurn: true },
      ),
    )
    const [result] = await waitForResults(client, task, 1)
    expect(result?.code).toBe(0)
    const [startLine, ...rest] = result?.stdout.split('\n') ?? []
    expect(startLine).toMatch(/^Started sub-agent “Explore the parser” \(Run [0-9a-f-]{36}\)/)
    expect(rest.join('\n')).toBe('The parser lives in src/parse.ts\n')

    const runs = await client.ok<RunSummary[]>('GET', `/tasks/${task.id}/runs`)
    const sub = runs.find((r) => r.role === 'sub-agent')
    expect(sub).toMatchObject({ name: 'Explore the parser', agent: 'claude', state: 'idle' })
    expect(sub?.parentRunId).toBe((await getTask(client, task.id)).leadRunId)
    const events = await client.ok<{ text: string }[]>('GET', `/tasks/${task.id}/events`)
    expect(events.map((e) => e.text)).toContain('Sub-agent “Explore the parser” started · Claude')
  })

  test('a Codex sub-agent takes its own name, model and effort; left-out options come from the Task Lead', async () => {
    const client = await startTed()
    const prompt = await promptFile(
      'review.md',
      undefined,
      { say: 'Looks fine' },
      { endTurn: true },
    )
    const task = await client.ok<Task>('POST', '/tasks', {
      title: steps(
        {
          run: [
            'sh',
            '-c',
            startAndWait(`--agent codex --name Reviewer --effort high --prompt-file ${prompt}`),
          ],
        },
        { run: ['sh', '-c', startAndWait(`--prompt-file ${prompt}`)] },
        { endTurn: true },
      ),
      factory: 'NB',
      lead: { agent: 'claude', model: 'opus', effort: 'low' },
    })
    await client.ok('POST', `/tasks/${task.id}/start`)
    const results = await waitForResults(client, task, 2)
    expect(results.map((r) => r.code)).toEqual([0, 0])
    expect(results[0]?.stdout).toMatch(/Looks fine/)

    const runs = await client.ok<RunSummary[]>('GET', `/tasks/${task.id}/runs`)
    const subs = runs.filter((r) => r.role === 'sub-agent')
    expect(subs.map((r) => [r.name, r.agent, r.model, r.effort]).sort()).toEqual([
      ['Reviewer', 'codex', undefined, 'high'],
      ['Sub-agent', 'claude', 'opus', 'low'],
    ])
  })

  test('--own-worktree gives the sub-agent a worktree and branch of its own', async () => {
    const client = await startTed()
    const prompt = await promptFile(
      'build.md',
      'Build it',
      { run: ['sh', '-c', 'pwd; git rev-parse --abbrev-ref HEAD'] },
      { endTurn: true },
    )
    const task = await startTask(
      client,
      steps(
        { run: ['sh', '-c', startAndWait(`--own-worktree --prompt-file ${prompt}`)] },
        { endTurn: true },
      ),
    )
    const [result] = await waitForResults(client, task, 1)
    const said = JSON.parse(result?.stdout.split('\n').slice(1).join('\n') ?? '{}') as {
      stdout: string
    }
    const [cwd, branch] = said.stdout.trim().split('\n')
    const current = await getTask(client, task.id)
    expect(cwd).not.toBe(current.repos[0]?.worktree)
    expect(cwd).toContain(path.join('worktrees', 'NB-1', 'sub-agents'))
    expect(branch).toBe(`${current.branch}-build-it`)
  })

  test('a sub-agent waits for a slot, and a Task Lead waiting only on it doesn’t hold one', async () => {
    const client = await startTed()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const release = path.join(scratch, 'release')
    const prompt = await promptFile(
      'slow.md',
      'Slow work',
      { waitFor: release },
      { say: 'Done slowly' },
      { endTurn: true },
    )
    const task = await startTask(
      client,
      steps({ run: ['sh', '-c', startAndWait(`--prompt-file ${prompt}`)] }, { endTurn: true }),
    )
    const waiting = await waitUntil(async () => {
      const current = await getTask(client, task.id)
      const sub = current.runs.find((r) => r.role === 'sub-agent')
      return sub?.state === 'working' && current.runs[0]?.onSubAgents ? current : undefined
    }, 'the sub-agent to start while the Task Lead waits')
    expect(waiting.runs.map((r) => [r.role, r.name])).toEqual([
      ['lead', 'Task Lead'],
      ['sub-agent', 'Slow work'],
    ])
    expect(waiting.status).toEqual({ kind: 'working' })
    const slots = await client.ok<RunSlots>('GET', '/slots')
    expect(slots).toMatchObject({ limit: 1, working: 1 })
    expect(slots.holders[0]).toMatchObject({ displayId: 'NB-1', runs: 1, subAgents: 1 })

    await writeFile(release, '')
    const [result] = await waitForResults(client, task, 1)
    expect(result?.stdout.split('\n')[0]).toMatch(/queued for a free slot/)
    expect(result?.stdout).toMatch(/Done slowly/)
  })

  test('a queued sub-agent request shows in the queue before queued Tasks', async () => {
    const client = await startTed()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const prompt = await promptFile('later.md', 'Later', { say: 'hi' }, { endTurn: true })
    const hold = path.join(scratch, 'hold')
    const task = await startTask(
      client,
      steps(
        { run: ['sh', '-c', `ted run start --prompt-file ${prompt}`] },
        { waitFor: hold },
        { endTurn: true },
      ),
    )
    await startTask(client, 'Second')
    const slots = await waitUntil(async () => {
      const current = await client.ok<RunSlots>('GET', '/slots')
      return current.queue.length === 2 ? current : undefined
    }, 'both to queue')
    expect(slots.queue.map((q) => [q.place, q.kind, q.displayId])).toEqual([
      [1, 'sub-agent', 'NB-1'],
      [2, 'task', 'NB-2'],
    ])
    expect(slots.queue[0]).toMatchObject({ name: 'Later', taskId: task.id })
    await writeFile(hold, '')
  })

  test('a sub-agent may post a note but not a question', async () => {
    const client = await startTed()
    const prompt = await promptFile(
      'talk.md',
      'Talker',
      { run: ['sh', '-c', 'ted comment "Found the bug"'] },
      { run: ['sh', '-c', 'ted comment --choice Yes --choice No "Fix it?"'] },
      { run: ['sh', '-c', 'ted outcome advance'] },
      { endTurn: true },
    )
    const task = await startTask(
      client,
      steps({ run: ['sh', '-c', startAndWait(`--prompt-file ${prompt}`)] }, { endTurn: true }),
    )
    await waitForResults(client, task, 1)
    const sub = (await client.ok<RunSummary[]>('GET', `/tasks/${task.id}/runs`)).find(
      (r) => r.role === 'sub-agent',
    )
    const { conversation } = await client.ok<{ conversation: never[] }>('GET', `/runs/${sub?.id}`)
    const said = assistantTexts(conversation).join('\n')
    expect(said).toMatch(/only plain notes/)
    expect(said).toMatch(/only the Task Lead reports outcomes/)
    const comments = await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)
    expect(comments.map((c) => [c.kind, c.body])).toEqual([['note', 'Found the bug']])
    expect((await getTask(client, task.id)).stage).toBe('intake')
  })

  test('a failed sub-agent is reported to the Task Lead, with no Inbox item', async () => {
    const client = await startTed()
    const prompt = await promptFile('crash.md', 'Crasher', { say: 'Trying' }, { exit: 3 })
    const task = await startTask(
      client,
      steps({ run: ['sh', '-c', startAndWait(`--prompt-file ${prompt}`)] }, { endTurn: true }),
    )
    const [result] = await waitForResults(client, task, 1)
    expect(result?.code).toBe(1)
    expect(result?.stderr).toMatch(/sub-agent “Crasher” failed/)
    expect(result?.stdout).toMatch(/Trying/)
    const runs = await client.ok<RunSummary[]>('GET', `/tasks/${task.id}/runs`)
    expect(runs.find((r) => r.role === 'sub-agent')?.state).toBe('finished')
    expect(await client.ok<unknown[]>('GET', '/inbox')).toEqual([])
  })

  test('ted run send sends a follow-up and ted run wait returns the new answer', async () => {
    const client = await startTed()
    const prompt = await promptFile(
      'chat.md',
      'Chatty',
      { everyMessage: [{ say: 'Second answer' }, { endTurn: true }] },
      { say: 'First answer' },
      { endTurn: true },
    )
    const task = await startTask(
      client,
      steps(
        {
          run: [
            'sh',
            '-c',
            `${startAndWait(`--prompt-file ${prompt}`)}; id=$(echo "$out" | ${runIdOf}); ted run send "$id" "And then?" >/dev/null && ted run wait "$id"`,
          ],
        },
        { endTurn: true },
      ),
    )
    const [result] = await waitForResults(client, task, 1)
    expect(result?.stdout.split('\n').slice(1)).toEqual(['First answer', 'Second answer', ''])
  })

  test('the human stops a sub-agent, and the waiting Task Lead hears it', async () => {
    const client = await startTed()
    const prompt = await promptFile(
      'forever.md',
      'Forever',
      { waitFor: path.join(scratch, 'never') },
      { endTurn: true },
    )
    const task = await startTask(
      client,
      steps({ run: ['sh', '-c', startAndWait(`--prompt-file ${prompt}`)] }, { endTurn: true }),
    )
    const sub = await waitUntil(async () => {
      const runs = await client.ok<RunSummary[]>('GET', `/tasks/${task.id}/runs`)
      return runs.find((r) => r.role === 'sub-agent' && r.state === 'working')
    }, 'the sub-agent to work')
    const stopped = await client.ok<RunSummary>('POST', `/runs/${sub.id}/stop`)
    expect(stopped.state).toBe('finished')
    const [result] = await waitForResults(client, task, 1)
    expect(result?.code).toBe(1)
    expect(result?.stderr).toMatch(/sub-agent “Forever” was stopped/)
  })

  test('two sub-agents with the same name each get their own worktree', async () => {
    const client = await startTed()
    const prompt = await promptFile('twin.md', 'Twin', { run: ['pwd'] }, { endTurn: true })
    const start = `ted run start --own-worktree --prompt-file ${prompt} | ${runIdOf}`
    const task = await startTask(
      client,
      steps(
        {
          run: ['sh', '-c', `a=$(${start}); b=$(${start}); ted run wait "$a"; ted run wait "$b"`],
        },
        { endTurn: true },
      ),
    )
    const [result] = await waitForResults(client, task, 1)
    expect(result?.code).toBe(0)
    const dirs = (await client.ok<RunSummary[]>('GET', `/tasks/${task.id}/runs`))
      .filter((r) => r.role === 'sub-agent')
      .map((r) => r.state)
    expect(dirs).toEqual(['idle', 'idle'])
    const cwds = result?.stdout
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => (JSON.parse(l) as { stdout: string }).stdout.trim())
    expect(new Set(cwds).size).toBe(2)
  })

  test('when the Task Lead Run ends, its sub-agents stop', async () => {
    const client = await startTed()
    const prompt = await promptFile(
      'forever.md',
      'Forever',
      { waitFor: path.join(scratch, 'never') },
      { endTurn: true },
    )
    const task = await startTask(
      client,
      steps({ run: ['sh', '-c', `ted run start --prompt-file ${prompt}`] }, { exit: 0 }),
    )
    const sub = await waitUntil(async () => {
      const runs = await client.ok<RunSummary[]>('GET', `/tasks/${task.id}/runs`)
      const found = runs.find((r) => r.role === 'sub-agent')
      return found?.state === 'finished' ? found : undefined
    }, 'the sub-agent to stop')
    expect(sub.failed).toBeUndefined()
  })

  test('only the Task Lead may start sub-agents', async () => {
    const client = await startTed()
    const inner = await promptFile('inner.md', 'Inner', { say: 'x' }, { endTurn: true })
    const outer = await promptFile(
      'outer.md',
      'Outer',
      { run: ['sh', '-c', `ted run start --prompt-file ${inner}`] },
      { endTurn: true },
    )
    const task = await startTask(
      client,
      steps({ run: ['sh', '-c', startAndWait(`--prompt-file ${outer}`)] }, { endTurn: true }),
    )
    const [result] = await waitForResults(client, task, 1)
    expect(result?.stdout).toMatch(/only the Task Lead can start and steer sub-agents/)
  })
})
