import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type Comment,
  type Factory,
  type RunChat,
  type RunSummary,
  type Task,
  type ThreadEvent,
  tedPaths,
} from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import {
  api,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  rawRequest,
  stubClaudePath,
  stubCodexPath,
  tokenFor,
  waitUntil,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-chat-'))
  origin = await makeOriginRepo(scratch)
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
  return { ...client, ok }
}

type Client = Awaited<ReturnType<typeof startTed>>

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })

const tool = (id: string, name: string, input: Record<string, unknown>) => ({
  emit: {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  },
})

const result = (id: string, content: string) => ({
  emit: {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  },
})

const getTask = async (client: Client, id: string) => {
  const task = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)
  if (!task) throw new Error(`no Task ${id}`)
  return task
}

async function startTask(client: Client, title: string) {
  await commitToOrigin(scratch, { '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n' })
  await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const task = await client.ok<Task>('POST', '/tasks', { title, factory: 'NB', start: true })
  return waitUntil(async () => {
    const current = await getTask(client, task.id)
    const run = current.runs[0]
    return run?.state === 'idle' && current.leadRunId !== undefined ? current : undefined
  }, 'the Task Lead to go idle')
}

const chatOf = (client: Client, runId: string) => client.ok<RunChat>('GET', `/runs/${runId}/chat`)

describe('Run chat', () => {
  test('shows TED’s instructions, the prompt, messages, tool calls and edits as diffs', async () => {
    const client = await startTed()
    const task = await startTask(
      client,
      steps(
        tool('t1', 'Edit', { file_path: 'notes.ts', old_string: 'a\nb\n', new_string: 'a\nc\n' }),
        result('t1', 'The file was updated'),
        tool('t2', 'Bash', { command: 'pnpm test', description: 'Run the tests' }),
        result('t2', 'all passed'),
        { say: 'The edit is in.' },
        { endTurn: true, usage: { input_tokens: 1200, output_tokens: 300 } },
      ),
    )
    const chat = await chatOf(client, task.leadRunId ?? '')

    expect(chat.run).toMatchObject({
      name: 'Task Lead',
      role: 'lead',
      agent: 'claude',
      state: 'idle',
      tokens: 1500,
      current: true,
    })
    const [instructions, prompt, ...rest] = chat.items
    expect(instructions).toMatchObject({ kind: 'instructions' })
    expect(instructions?.kind === 'instructions' && instructions.text).toMatch(/^# Working in TED/)
    expect(prompt).toMatchObject({ kind: 'prompt' })
    expect(prompt?.kind === 'prompt' && prompt.text).toContain('# Your Task: NB-1')
    expect(prompt?.kind === 'prompt' && prompt.text).not.toContain('# Working in TED')
    expect(rest.map((item) => item.kind)).toEqual(['tool', 'tool', 'agent'])
    expect(rest[0]).toMatchObject({
      kind: 'tool',
      tool: 'Edit',
      title: 'notes.ts',
      status: 'done',
      output: 'The file was updated',
      diffs: [
        {
          path: 'notes.ts',
          additions: 1,
          deletions: 1,
          lines: [
            { kind: 'context', text: 'a' },
            { kind: 'removed', text: 'b' },
            { kind: 'added', text: 'c' },
          ],
        },
      ],
    })
    expect(rest[1]).toMatchObject({
      kind: 'tool',
      tool: 'Bash',
      title: 'pnpm test',
      detail: 'Run the tests',
      output: 'all passed',
    })
    expect(rest[2]).toMatchObject({ kind: 'agent', text: 'The edit is in.' })
    expect(rest[2]?.kind === 'agent' && rest[2].writing).toBeUndefined()
  })

  test('a message goes only to that Run, isn’t a Comment, and leaves a thread line for the Task Lead', async () => {
    const client = await startTed()
    const task = await startTask(client, steps({ everyMessage: [{ endTurn: true }] }, { endTurn: true }))
    const runId = task.leadRunId ?? ''
    const before = await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)

    const sent = await client.ok<{ id: string; text: string }>('POST', `/runs/${runId}/messages`, {
      text: 'Keep pinned notes in the order they were pinned.',
    })

    const chat = await waitUntil(async () => {
      const current = await chatOf(client, runId)
      return current.items.some((i) => i.kind === 'human' && i.sent) ? current : undefined
    }, 'the agent to take the message')
    expect(chat.items.filter((i) => i.kind === 'human')).toEqual([
      expect.objectContaining({ id: sent.id, text: sent.text, sent: true }),
    ])
    expect(await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)).toEqual(before)
    const lines = await client.ok<ThreadEvent[]>('GET', `/tasks/${task.id}/events`)
    expect(lines.filter((l) => l.runId !== undefined)).toEqual([
      expect.objectContaining({
        text: 'You steered the Task Lead in its Conversation',
        runId,
        tone: 'edit',
      }),
    ])
    expect(JSON.stringify(lines)).not.toContain('pinned notes')
  })

  test('Restart is refused while the Run works and resumes the same Run when it’s idle', async () => {
    const client = await startTed()
    const task = await startTask(client, steps({ endTurn: true }))
    const runId = task.leadRunId ?? ''
    const release = path.join(scratch, 'release')
    await client.ok('POST', `/runs/${runId}/messages`, {
      text: steps({ waitFor: release }, { endTurn: true }),
    })
    await waitUntil(
      async () => ((await chatOf(client, runId)).run.state === 'working' ? true : undefined),
      'the Run to work',
    )
    const refused = await client.call('POST', `/runs/${runId}/restart`)
    expect(refused).toEqual({
      status: 409,
      body: { error: 'The Run is working. Restart it when it’s idle or waiting.' },
    })

    await writeFile(release, '')
    await waitUntil(
      async () => ((await chatOf(client, runId)).run.state === 'idle' ? true : undefined),
      'the Run to go idle',
    )
    const restarted = await client.ok<RunSummary>('POST', `/runs/${runId}/restart`)
    expect(restarted).toMatchObject({ id: runId, state: 'idle' })
    const { run } = await client.getRun(runId)
    const starts = await waitUntil(async () => {
      const lines = (await readFile(path.join(run.cwd, 'stub-starts.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { argv: string[] })
      return lines.length === 2 ? lines : undefined
    }, 'the agent to start again')
    expect(starts[1]?.argv).toEqual(expect.arrayContaining(['--resume', run.sessionId]))
    expect((await getTask(client, task.id)).leadRunId).toBe(runId)
  })

  test('Stop Run is refused for the Task Lead', async () => {
    const client = await startTed()
    const task = await startTask(client, steps({ endTurn: true }))
    expect(await client.call('POST', `/runs/${task.leadRunId}/stop`)).toEqual({
      status: 409,
      body: { error: 'This is the Task Lead. Stop the Task instead.' },
    })
  })

  test('Conversation tabs belong to the Task and survive a daemon restart', async () => {
    const client = await startTed()
    const task = await startTask(client, steps({ endTurn: true }))
    const runId = task.leadRunId ?? ''
    const opened = await client.ok<Task>('PUT', `/tasks/${task.id}/tabs/${runId}`)
    expect(opened.tabs).toEqual([{ runId, name: 'Task Lead', agent: 'claude', state: 'idle' }])
    expect(await client.ok<RunSummary[]>('GET', `/tasks/${task.id}/runs`)).toEqual([
      expect.objectContaining({ id: runId, name: 'Task Lead', current: true }),
    ])

    await daemon?.stop()
    const again = await startTed()
    expect((await getTask(again, task.id)).tabs.map((t) => t.runId)).toEqual([runId])
    const closed = await again.ok<Task>('DELETE', `/tasks/${task.id}/tabs/${runId}`)
    expect(closed.tabs).toEqual([])
  })

  test('the chat routes are closed to Runs', async () => {
    const client = await startTed()
    const runToken = (await loadRunTokens(tedPaths(home).runTokenKey)).issue('run-1')
    for (const [method, route] of [
      ['GET', '/runs/run-1/chat'],
      ['POST', '/runs/run-1/messages'],
      ['POST', '/runs/run-1/restart'],
      ['POST', '/runs/run-1/stop'],
      ['GET', '/tasks/NB-1/runs'],
      ['PUT', '/tasks/NB-1/tabs/run-1'],
      ['DELETE', '/tasks/NB-1/tabs/run-1'],
    ] as const) {
      const res = await rawRequest(daemon?.port ?? 0, {
        method,
        path: route,
        headers: { authorization: `Bearer ${runToken}` },
      })
      expect(res.status, `${method} ${route}`).toBe(403)
    }
    expect((await client.call('GET', '/runs/nope/chat')).status).toBe(404)
  })

  test('Codex commands, file changes and streaming messages show in the chat', async () => {
    const client = await startTed()
    const run = await client.startRun(
      [
        {
          notify: 'item/started',
          params: {
            item: { type: 'commandExecution', id: 'c1', command: "/bin/zsh -lc 'pnpm test'" },
          },
        },
        {
          notify: 'item/completed',
          params: {
            item: {
              type: 'commandExecution',
              id: 'c1',
              command: "/bin/zsh -lc 'pnpm test'",
              aggregatedOutput: 'ok\n',
              exitCode: 1,
            },
          },
        },
        {
          notify: 'item/completed',
          params: {
            item: {
              type: 'fileChange',
              id: 'f1',
              changes: [
                {
                  path: path.join(scratch, 'notes.ts'),
                  kind: { type: 'update' },
                  diff: '@@ -1,2 +1,2 @@\n a\n-b\n+c\n',
                },
              ],
            },
          },
        },
        { notify: 'item/agentMessage/delta', params: { itemId: 'm1', delta: 'Writ' } },
        { notify: 'item/agentMessage/delta', params: { itemId: 'm1', delta: 'ing' } },
      ],
      scratch,
      'codex',
    )
    const chat = await waitUntil(async () => {
      const current = await chatOf(client, run.id)
      return current.items.some((i) => i.kind === 'agent' && i.text === 'Writing')
        ? current
        : undefined
    }, 'the streaming message')
    expect(chat.run).toMatchObject({ name: 'Run', role: 'run', agent: 'codex' })
    expect(chat.items.slice(1)).toEqual([
      expect.objectContaining({
        kind: 'tool',
        tool: 'Shell',
        title: 'pnpm test',
        status: 'failed',
        output: 'ok\n',
      }),
      expect.objectContaining({
        kind: 'tool',
        tool: 'Edit',
        title: 'Edited notes.ts',
        diffs: [
          expect.objectContaining({
            path: 'notes.ts',
            additions: 1,
            deletions: 1,
          }),
        ],
      }),
      expect.objectContaining({ kind: 'agent', text: 'Writing', writing: true }),
    ])
  })
})
