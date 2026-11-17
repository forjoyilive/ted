import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  type AgentSummary,
  type Coordinator,
  type Factory,
  type Plan,
  type RunWithConversation,
  readDaemonInfo,
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

const exec = promisify(execFile)

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
  delete process.env.TED_STUB_GH
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
    await run.call('GET', '/coordinator/automations'),
    await run.call('GET', '/coordinator/automations/a1'),
    await run.call('POST', '/coordinator/automation-drafts', {
      operation: 'op-draft',
      kind: 'create',
      fields: { name: 'Daily', prompt: 'Go', schedule: { kind: 'daily', at: '09:00' } },
    }),
    await run.call('GET', '/coordinator/agents'),
    await run.call('POST', '/coordinator/requests', {
      agent: { id: 'helper', name: 'Helper', instructions: 'Help.', powers: [] },
    }),
  ]
  for (const res of refused) {
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).toMatch(
      /Scout doesn’t have the (Manage Tasks|Propose Tasks|Manage Automations|Manage Agents) power/,
    )
  }

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

test('a Coordinator drafts Agents that only the app creates, in the Library or as a settings pull request', async () => {
  const ghState = path.join(scratch, 'gh.json')
  await writeFile(ghState, JSON.stringify({ merge: { origin, updateBase: true } }))
  process.env.TED_STUB_GH = ghState
  await commitToOrigin(scratch, {
    '.ted/agents.yaml': scoutYaml,
    '.ted/agents/scout.md': 'You scout releases.\n',
  })
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const port = daemon.port
  const app = api(port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: JsonObject): Promise<T> => {
    const res = await app.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  const tokens = await loadRunTokens(tedPaths(home).runTokenKey)
  const factory = await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const started = await ok<Coordinator>('POST', `/factories/${factory.id}/coordinator-chats`, {
    agent: 'claude',
    text: JSON.stringify({ steps: [{ everyMessage: [{ endTurn: true }] }, { endTurn: true }] }),
  })
  expect(started.chatAgent.powers).toEqual([
    'ask',
    'manage_tasks',
    'manage_automations',
    'manage_agents',
  ])
  const chatPath = `/coordinator-chats/${started.id}`
  await waitUntil(async () => (await ok<Coordinator>('GET', chatPath)).started, 'the chat')
  const prompt = (await ok<RunWithConversation>('GET', `/runs/${started.runId}`)).run.prompt ?? ''
  expect(prompt).toContain('ted coordinator agent-draft --file <file>')
  const run = api(port, tokens.issue(started.runId))

  const listed = await run.call('GET', '/coordinator/agents')
  expect(listed.status).toBe(200)
  expect(listed.body.context).toMatch(/^<<<AGENT FILES [0-9a-f-]+>>>/)
  expect(listed.body.context).toContain('You are the Coordinator for one TED Factory')

  const token = `sk-${'a'.repeat(30)}`
  const draft = {
    id: 'billing-guide',
    name: 'Billing guide',
    instructions: `# Billing guide\n\nAnswer billing questions. Key: ${token}\n`,
    powers: ['ask', 'read_code'],
    summary: 'Reads the billing code and answers questions.',
  }
  const post = (agent: JsonObject) => run.call('POST', '/coordinator/requests', { agent })
  expect((await post({ ...draft, powers: ['deploy'] })).status).toBe(400)
  expect((await post({ ...draft, id: 'planner' })).status).toBe(409)
  expect((await post({ ...draft, id: 'nobody', change: true })).status).toBe(404)
  expect(
    (await post({ ...draft, id: 'planner', change: true, powers: ['manage_agents'] })).status,
  ).toBe(400)
  const posted = await post(draft)
  expect(posted.status).toBe(201)
  expect(posted.body).toMatchObject({
    kind: 'agent',
    title: 'New Agent: Billing guide',
    agentDraft: { id: 'billing-guide', powers: ['ask', 'read_code'] },
  })
  expect(posted.body.agentDraft.instructions).not.toContain(token)
  expect(posted.body.agentDraft.current).toBeUndefined()
  const waiting = await ok<WaitingRequest[]>('GET', '/inbox/waiting')
  expect(waiting.find((w) => w.id === posted.body.id)).toMatchObject({
    source: 'coordinator',
    chatId: started.id,
    requestKind: 'agent',
  })

  const answerPath = `${chatPath}/requests/${posted.body.id}/agent`
  const create = {
    action: 'create',
    where: 'library',
    name: 'Billing guide',
    instructions: '# Billing guide\n\nAnswer billing questions.\n',
    powers: ['read_code'],
  }
  const info = await readDaemonInfo(home)
  expect((await run.call('POST', answerPath, create)).status).toBe(403)
  expect((await api(port, info?.token ?? '').call('POST', answerPath, create)).status).toBe(403)
  expect(
    (await run.call('POST', `${chatPath}/requests/${posted.body.id}/answer`, { action: 'approve' }))
      .status,
  ).toBe(403)
  expect(
    (await app.call('POST', `${chatPath}/requests/${posted.body.id}/answer`, { action: 'approve' }))
      .status,
  ).toBe(400)
  const widened = await app.call('POST', answerPath, { ...create, powers: ['manage_tasks'] })
  expect(widened.status).toBe(400)
  expect(JSON.stringify(widened.body)).toContain('The draft doesn’t give Manage Tasks')

  const answered = await ok<Coordinator>('POST', answerPath, create)
  expect(answered.requests?.find((r) => r.id === posted.body.id)?.answer).toMatchObject({
    kind: 'approved',
    text: 'Created “Billing guide” in the Library.',
  })
  expect(await readFile(path.join(home, 'library', 'agents', 'billing-guide.md'), 'utf8')).toBe(
    create.instructions,
  )
  const agents = await ok<AgentSummary[]>('GET', `/factories/${factory.id}/agents`)
  expect(agents.find((a) => a.id === 'billing-guide')).toEqual({
    id: 'billing-guide',
    name: 'Billing guide',
    source: 'library',
    powers: ['read_code'],
  })
  await waitUntil(
    async () =>
      JSON.stringify(await ok('GET', `${chatPath}/chat`)).includes(
        'Created “Billing guide” in the Library.',
      ) || undefined,
    'the result to reach the Coordinator',
  )

  const change = await post({
    id: 'billing-guide',
    name: 'Billing guide',
    instructions: '# Billing guide\n\nAnswer billing and invoice questions.\n',
    powers: ['ask', 'read_code'],
    change: true,
  })
  expect(change.status).toBe(201)
  expect(change.body).toMatchObject({
    title: 'Change to Billing guide',
    agentDraft: { current: { source: 'library', powers: ['read_code'] } },
  })
  await ok('POST', `${chatPath}/requests/${change.body.id}/agent`, { action: 'dismiss' })
  expect(
    (await ok<Coordinator>('GET', chatPath)).requests?.find((r) => r.id === change.body.id)?.answer,
  ).toMatchObject({ kind: 'denied' })

  const scout = await post({
    id: 'scout',
    name: 'Scout',
    instructions: 'You scout releases and tags.\n',
    powers: ['ask', 'read_code'],
    change: true,
  })
  expect(scout.body.agentDraft.current).toMatchObject({ source: 'factory' })
  const toLibrary = await app.call('POST', `${chatPath}/requests/${scout.body.id}/agent`, {
    action: 'create',
    where: 'library',
    name: 'Scout',
    instructions: 'You scout releases and tags.\n',
    powers: ['ask', 'read_code'],
  })
  expect(toLibrary.status).toBe(409)
  expect(JSON.stringify(toLibrary.body)).toContain('This Factory defines `scout`')
  expect(existsSync(path.join(home, 'library', 'agents', 'scout.md'))).toBe(false)
  await ok('POST', `${chatPath}/requests/${scout.body.id}/agent`, { action: 'dismiss' })

  const second = await post({
    id: 'release-notes',
    name: 'Release notes',
    instructions: '# Release notes\n\nWrite the notes.\n',
    powers: ['ask'],
  })
  const opened = await ok<Coordinator>('POST', `${chatPath}/requests/${second.body.id}/agent`, {
    action: 'create',
    where: 'factory',
    name: 'Release notes',
    instructions: '# Release notes\n\nWrite the notes.\n',
    powers: ['ask'],
  })
  const result = opened.requests?.find((r) => r.id === second.body.id)?.answer
  expect(result).toMatchObject({ kind: 'approved' })
  expect(result?.kind === 'approved' && result.text).toMatch(
    /^Opened a settings pull request: .+\. “Release notes” is available once it merges\.$/,
  )
  const { stdout: branches } = await exec(
    'git',
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
    { cwd: origin },
  )
  const branch = branches.split('\n').find((b) => b.startsWith('ted/settings-')) ?? ''
  const show = async (file: string) =>
    (await exec('git', ['show', `${branch}:${file}`], { cwd: origin })).stdout
  expect(await show('.ted/agents.yaml')).toContain('release-notes:')
  expect(await show('.ted/agents/release-notes.md')).toBe('# Release notes\n\nWrite the notes.\n')
  expect(await show('.ted/agents.yaml')).toContain('scout:')
  expect(
    (await exec('git', ['ls-tree', '-r', '--name-only', 'main', '.ted/'], { cwd: origin })).stdout,
  ).not.toContain('release-notes')
}, 120_000)
