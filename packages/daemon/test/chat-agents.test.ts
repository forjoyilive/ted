import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type AgentSummary,
  type Coordinator,
  type Factory,
  type Plan,
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
