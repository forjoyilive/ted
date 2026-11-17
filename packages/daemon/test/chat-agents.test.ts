import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type AgentSummary,
  type Coordinator,
  type Factory,
  type Plan,
  type RunChat,
  type RunWithConversation,
  tedPaths,
  type WaitingRequest,
} from '@ted/protocol'
import type { JsonObject } from '@ted/protocol/parse'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import {
  api,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  stubCodexPath,
  waitUntil,
} from './helpers.ts'
import { sandboxReasons, skipInsideTedSandbox } from './support/ted-sandbox.ts'

let home: string,
  scratch: string,
  origin: string,
  cleanup: () => Promise<void>,
  daemon: RunningDaemon | undefined
beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-chat-agents-'))
  origin = await makeOriginRepo(scratch)
})
afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

const scoutYaml = [
  'scout:',
  '  name: Scout',
  '  powers: [ask, read_code]',
  'planner:',
  '  powers: [ask, read_code]',
  '',
].join('\n')

test('a chat runs a repo Agent with the powers it had when the chat started', async () => {
  await commitToOrigin(scratch, {
    '.ted/agents.yaml': scoutYaml,
    '.ted/agents/scout.md': 'You scout releases.\n',
  })
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    codexBin: stubCodexPath,
  })
  const port = daemon.port
  const app = api(port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: JsonObject): Promise<T> => {
    const res = await app.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  const tokens = await loadRunTokens(tedPaths(home).runTokenKey)
  const factory = await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const refresh = () => ok('GET', `/factories/${factory.id}/settings?refresh=first`)

  const agents = await ok<AgentSummary[]>('GET', `/factories/${factory.id}/agents`)
  expect(agents.find((a) => a.id === 'scout')).toEqual({
    id: 'scout',
    name: 'Scout',
    source: 'factory',
    powers: ['ask', 'read_code'],
  })
  expect(agents.find((a) => a.id === 'planner')?.powers).toEqual(['ask', 'read_code'])

  const round = path.join(scratch, 'round.json')
  await writeFile(
    round,
    JSON.stringify({
      title: 'Release scope',
      questions: [{ question: 'Ship today?', recommended: 'Yes', choices: ['Yes', 'No'] }],
    }),
  )
  const cwdFile = path.join(scratch, 'cwd.txt')
  const answered = path.join(scratch, 'answered')
  const started = await ok<Coordinator>('POST', `/factories/${factory.id}/coordinator-chats`, {
    agentId: 'scout',
    agent: 'claude',
    text: JSON.stringify({
      steps: [
        { everyMessage: [{ run: ['touch', answered] }, { endTurn: true }] },
        { run: ['sh', '-c', `pwd > ${cwdFile}`] },
        { run: ['ted', 'ask', '--round', round] },
        { waitFor: path.join(scratch, 'finish') },
        { endTurn: true },
      ],
    }),
  })
  expect(started.chatAgent).toEqual({
    id: 'scout',
    name: 'Scout',
    source: 'factory',
    powers: ['ask', 'read_code'],
    removed: false,
  })
  const chatPath = `/coordinator-chats/${started.id}`
  const asked = await waitUntil(
    async () => (await ok<Coordinator>('GET', chatPath)).requests?.[0],
    'the chat’s round',
  )
  expect(asked).toMatchObject({ kind: 'round', title: 'Release scope', round: { number: 1 } })
  const waiting = await ok<WaitingRequest[]>('GET', '/inbox/waiting')
  expect(waiting.find((w) => w.id === asked.id)).toMatchObject({
    source: 'coordinator',
    chatId: started.id,
    agentName: 'Scout',
    requestKind: 'round',
  })

  const cwd = (await readFile(cwdFile, 'utf8')).trim()
  expect(cwd.startsWith(path.join(await realpath(home), 'chat-code', started.id))).toBe(true)
  expect(existsSync(path.join(cwd, '.ted', 'agents', 'scout.md'))).toBe(true)
  const prompt = (await ok<RunWithConversation>('GET', `/runs/${started.runId}`)).run.prompt ?? ''
  expect(prompt).toContain('You scout releases.')
  expect(prompt).toContain('ted ask --round <file>')
  expect(prompt).not.toContain('ted coordinator')

  const run = api(port, tokens.issue(started.runId))
  const version = 'a'.repeat(64)
  const refused = [
    await run.call('GET', '/coordinator/tasks'),
    await run.call('GET', '/coordinator/tasks/NB-1'),
    await run.call('POST', '/coordinator/tasks', { operation: 'op-create', title: 'New' }),
    ...(await Promise.all(
      ['archive', 'unarchive', 'delete'].map((kind) =>
        run.call('POST', `/coordinator/${kind}`, {
          operation: `op-${kind}`,
          tasks: [{ id: 'NB-1', version }],
        }),
      ),
    )),
    await run.call('POST', '/coordinator/tasks/NB-1/done', { operation: 'op-done', version }),
    await run.call('POST', '/coordinator/tasks/NB-1/resume', { operation: 'op-resume', version }),
    await run.call('POST', '/coordinator/tasks/NB-1/tell', {
      operation: 'op-tell',
      version,
      message: 'Go',
    }),
    await run.call('POST', '/coordinator/requests', {
      proposal: { title: 'Pieces', tasks: [{ title: 'One', scope: 'One thing' }] },
    }),
  ]
  for (const res of refused) {
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).toMatch(/Scout doesn’t have the (Manage|Propose) Tasks power/)
  }
  const command = await run.call('POST', '/chat-commands', { name: 'test' })
  expect(command.status).toBe(403)
  expect(JSON.stringify(command.body)).toContain('Run commands in the copy')

  await writeFile(path.join(scratch, 'finish'), '')
  await waitUntil(
    async () => (await ok<Coordinator>('GET', chatPath)).status === 'ready',
    'the first turn to end',
  )
  await ok('POST', `${chatPath}/requests/${asked.id}/answer`, { action: 'accept-recommended' })
  await waitUntil(() => existsSync(answered), 'the answer to reach the Run')
  expect((await ok<Coordinator>('GET', chatPath)).requests?.[0]?.answer).toMatchObject({
    kind: 'answered',
    answers: [{ answer: 'Yes' }],
  })
  expect((await ok<WaitingRequest[]>('GET', '/inbox/waiting')).map((w) => w.id)).not.toContain(
    asked.id,
  )

  const plan = await ok<Plan>('POST', '/plans', {
    factory: 'NB',
    message: JSON.stringify({ steps: [{ waitFor: path.join(scratch, 'plan-finish') }] }),
    agent: 'claude',
  })
  expect(plan.chatAgent).toMatchObject({ id: 'planner', powers: ['ask', 'read_code'] })
  await waitUntil(
    async () =>
      (await ok<{ plan: Plan }>('GET', `/plans/${plan.id}`)).plan.status === 'working' || undefined,
    'the Planner to start',
  )
  const planner = api(port, tokens.issue(plan.id))
  const proposed = await planner.call('POST', '/plan-runs/requests', {
    proposal: { title: 'Pieces', tasks: [{ title: 'One', scope: 'One thing' }] },
  })
  expect(proposed.status).toBe(403)
  expect(JSON.stringify(proposed.body)).toContain('Propose Tasks')
  const ranWithout = await planner.call('POST', '/chat-commands', { name: 'test' })
  expect(ranWithout.status).toBe(403)
  expect(JSON.stringify(ranWithout.body)).toContain('Run commands in the copy')
  await writeFile(path.join(scratch, 'plan-finish'), '')

  await commitToOrigin(scratch, {
    '.ted/agents.yaml': 'scout:\n  name: Scout\n  powers: [propose_tasks]\n',
    '.ted/agents/scout.md': 'You scout faster.\n',
  })
  await refresh()
  const kept = await ok<Coordinator>('GET', chatPath)
  expect(kept.chatAgent).toMatchObject({ powers: ['ask', 'read_code'], removed: false })
  const next = await ok<Coordinator>('POST', `/factories/${factory.id}/coordinator-chats`, {
    agentId: 'scout',
    agent: 'claude',
    text: JSON.stringify({ steps: [{ endTurn: true }] }),
  })
  expect(next.chatAgent).toMatchObject({ powers: ['propose_tasks'] })
  await waitUntil(
    async () => (await ok<Coordinator>('GET', `/coordinator-chats/${next.id}`)).started,
    'the second chat',
  )
  const nextPrompt = (await ok<RunWithConversation>('GET', `/runs/${next.runId}`)).run.prompt ?? ''
  expect(nextPrompt).toContain('You scout faster.')
  expect(nextPrompt).toContain('ted task propose --file <file>')
  expect(nextPrompt).not.toContain('ted ask')

  await commitToOrigin(scratch, { '.ted/agents.yaml': '# no Agents of our own\n' })
  await refresh()
  const orphan = await ok<Coordinator>('GET', chatPath)
  expect(orphan.chatAgent).toMatchObject({ id: 'scout', removed: true })
  expect(orphan.requests).toHaveLength(1)
  const message = await app.call('POST', `${chatPath}/messages`, { text: 'Still there?' })
  expect(message.status).toBe(409)
  expect(JSON.stringify(message.body)).toContain('was removed from this Factory’s Agent files')
  const checkout = path.join(home, 'chat-code', started.id)
  expect(existsSync(checkout)).toBe(true)
  await ok('POST', `${chatPath}/archive`, {})
  expect(existsSync(checkout)).toBe(false)
  await ok('DELETE', chatPath)
  expect((await app.call('GET', chatPath)).status).toBe(404)
}, 120_000)

test.runIf(process.platform === 'darwin')(
  'a chat runs its Agent’s named commands in its copy, in the sandbox, and archive ends what they left',
  async (context) => {
    skipInsideTedSandbox(context, sandboxReasons.processes)
    const planted = path.join(home, 'planted')
    const outside = path.join(scratch, 'outside')
    await commitToOrigin(scratch, {
      '.ted/agents.yaml': [
        'runner:',
        '  name: Runner',
        '  powers: [read_code, run_commands]',
        '  commands:',
        `    stub: "echo hello-from-stub; touch stub-inside; touch '${planted}' '${outside}' 2>/dev/null; exit 3"`,
        '    sleeper: "sleep 120 >/dev/null 2>&1 & echo $! > sleeper.pid"',
        '',
      ].join('\n'),
      '.ted/agents/runner.md': 'You run the checks.\n',
    })
    daemon = await startDaemon({
      home,
      version: '9.9.9',
      claudeBin: stubClaudePath,
      codexBin: stubCodexPath,
    })
    const app = api(daemon.port, { appKey: daemon.appToken })
    const ok = async <T>(method: string, route: string, body?: JsonObject): Promise<T> => {
      const res = await app.call(method, route, body)
      if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
      return res.body as T
    }
    const factory = await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
    const agents = await ok<AgentSummary[]>('GET', `/factories/${factory.id}/agents`)
    expect(agents.find((a) => a.id === 'runner')?.commands?.map((c) => c.name)).toEqual([
      'stub',
      'sleeper',
    ])

    const file = (name: string) => path.join(scratch, name)
    const ran = (name: string, out: string) => ({
      run: [
        'sh',
        '-c',
        `ted agent run ${name} > '${file(out)}' 2>&1; echo $? > '${file(`${out}.code`)}'`,
      ],
    })
    const started = await ok<Coordinator>('POST', `/factories/${factory.id}/coordinator-chats`, {
      agentId: 'runner',
      agent: 'claude',
      text: JSON.stringify({
        steps: [
          { run: ['sh', '-c', `pwd > '${file('cwd')}'`] },
          ran('stub', 'stub'),
          ran('deploy', 'deploy'),
          ran('sleeper', 'sleeper'),
          { waitFor: file('finish') },
          { endTurn: true },
        ],
      }),
    })
    await waitUntil(
      async () => (await ok<Coordinator>('GET', `/coordinator-chats/${started.id}`)).started,
      'the chat to start',
    )
    const prompt = (await ok<RunWithConversation>('GET', `/runs/${started.runId}`)).run.prompt ?? ''
    expect(prompt).toContain('- ted agent run <name>')
    expect(prompt).toContain('  - stub: `echo hello-from-stub;')

    await waitUntil(() => existsSync(file('sleeper.code')), 'the commands to run', 90_000)
    const stub = await readFile(file('stub'), 'utf8')
    expect(stub).toContain('TED ran `stub` in this chat’s copy: it failed with exit code 3.')
    expect(stub).toMatch(/<<<COMMAND OUTPUT [a-f0-9-]+>>>\nhello-from-stub\n/)
    expect((await readFile(file('stub.code'), 'utf8')).trim()).toBe('3')
    expect(await readFile(file('deploy'), 'utf8')).toContain(
      '`deploy` isn’t one of Runner’s commands',
    )
    expect((await readFile(file('deploy.code'), 'utf8')).trim()).not.toBe('0')
    expect((await readFile(file('sleeper.code'), 'utf8')).trim()).toBe('0')

    const checkout = path.join(home, 'chat-code', started.id)
    const copy = (await readFile(file('cwd'), 'utf8')).trim()
    expect(copy.startsWith(path.join(await realpath(home), 'chat-code', started.id))).toBe(true)
    expect(existsSync(path.join(copy, 'stub-inside'))).toBe(true)
    expect(existsSync(planted)).toBe(false)
    expect(existsSync(outside)).toBe(false)
    const chat = await ok<RunChat>('GET', `/runs/${started.runId}/chat`)
    expect(
      chat.items.flatMap((item) =>
        item.kind === 'command' ? [[item.name, item.status, item.exitCode]] : [],
      ),
    ).toEqual([
      ['stub', 'failed', 3],
      ['sleeper', 'passed', 0],
    ])
    expect(chat.items.find((item) => item.kind === 'command')).toMatchObject({
      output: expect.stringContaining('hello-from-stub'),
    })

    const sleeper = Number((await readFile(path.join(copy, 'sleeper.pid'), 'utf8')).trim())
    const alive = () => {
      try {
        process.kill(sleeper, 0)
        return true
      } catch {
        return false
      }
    }
    expect(alive()).toBe(true)
    const sandboxFolder = path.join(home, 'sandbox', `chat-${started.id}`)
    expect(existsSync(sandboxFolder)).toBe(true)
    await writeFile(file('finish'), '')
    await ok('POST', `/coordinator-chats/${started.id}/archive`, {})
    await waitUntil(() => !alive() || undefined, 'the leftover process to end')
    expect(existsSync(checkout)).toBe(false)
    expect(existsSync(sandboxFolder)).toBe(false)
  },
  120_000,
)
