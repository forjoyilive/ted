import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  DaemonClient,
  parseChangeAgentAvailabilityRequest,
  readDaemonInfo,
  tedPaths,
} from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { resolveAgentChoices } from '../src/workflow/agent-choices.ts'
import {
  appClient,
  devRunToken,
  hostsStarted,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  stubCodexPath,
  waitUntil,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-availability-'))
})

afterEach(async () => {
  await daemon?.stop()
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function start() {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    codexBin: stubCodexPath,
  })
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('Missing daemon info')
  return { client: appClient(info, daemon.appToken), info }
}

async function taskOf(client: DaemonClient, id: string) {
  const task = (await client.listTasks()).find((task) => task.id === id)
  if (!task) throw new Error('Missing Task')
  return task
}

test('availability request parser preserves every field and rejects invalid decisions', () => {
  const input = {
    agent: 'antigravity',
    enabled: false,
    existing: 'stop',
    confirmedRunIds: ['run-one', 'run-two'],
  }
  expect(parseChangeAgentAvailabilityRequest(input)).toEqual(input)
  for (const value of [
    null,
    [],
    { agent: 'unknown', enabled: false },
    { agent: 'codex', enabled: 1 },
    { agent: 'codex', enabled: false, existing: 'yes' },
    { agent: 'codex', enabled: false, confirmedRunIds: [3] },
  ]) {
    expect(() => parseChangeAgentAvailabilityRequest(value)).toThrow()
  }
})

test('only the app can toggle agents; generic settings cannot bypass the decision or disable the last agent', async () => {
  const { client, info } = await start()
  const input = { agent: 'codex' as const, enabled: false }
  await expect(new DaemonClient(info).changeAgentAvailability(input)).rejects.toThrow()
  await expect(new DaemonClient(info).agentAvailability()).rejects.toThrow()
  if (!daemon) throw new Error('Missing daemon')
  const token = await devRunToken(home, daemon.port, daemon.appToken)
  await expect(new DaemonClient(info, token).changeAgentAvailability(input)).rejects.toThrow()
  await expect(client.updateSettings({ enabledAgents: [] })).rejects.toThrow(/Settings/)
  expect((await client.changeAgentAvailability(input)).confirmationRequired).toBe(false)
  await client.changeAgentAvailability({ agent: 'antigravity', enabled: false })
  await expect(client.changeAgentAvailability({ agent: 'claude', enabled: false })).rejects.toThrow(
    /another agent/,
  )
  await expect(
    client.startDevRun({ agent: 'codex', prompt: 'Do not start', cwd: scratch }),
  ).rejects.toThrow(/off/)
  expect((await client.getSettings()).enabledAgents).toEqual(['claude'])
})

test('confirmation refreshes when another Run starts; keep-going and availability persist through restart', async () => {
  let { client } = await start()
  const first = await client.startDevRun({
    agent: 'claude',
    prompt: 'Wait for instructions',
    cwd: scratch,
  })
  const initial = await client.changeAgentAvailability({ agent: 'claude', enabled: false })
  expect(initial.confirmationRequired).toBe(true)
  expect(initial.availability.runs.map((run) => run.id)).toContain(first.id)
  expect((await client.getSettings()).enabledAgents).toContain('claude')
  const second = await client.startDevRun({ agent: 'claude', prompt: 'Wait too', cwd: scratch })
  const stale = await client.changeAgentAvailability({
    agent: 'claude',
    enabled: false,
    existing: 'stop',
    confirmedRunIds: [first.id],
  })
  expect(stale.confirmationRequired).toBe(true)
  expect(stale.availability.runs.map((run) => run.id).sort()).toEqual([first.id, second.id].sort())
  const kept = await client.changeAgentAvailability({
    agent: 'claude',
    enabled: false,
    existing: 'keep',
    confirmedRunIds: [first.id, second.id],
  })
  expect(kept.confirmationRequired).toBe(false)
  expect(kept.availability.runs).toHaveLength(2)
  await hostsStarted(home)
  await daemon?.stop()
  ;({ client } = await start())
  expect((await client.getSettings()).enabledAgents).not.toContain('claude')
  expect((await client.getRun(first.id)).run.state).not.toBe('finished')
  await client.sendRunMessage(first.id, 'Continue the same conversation')
  await client.changeAgentAvailability({ agent: 'claude', enabled: true })
  const next = await client.startDevRun({
    agent: 'claude',
    prompt: 'Available again',
    cwd: scratch,
  })
  expect(next.agent).toBe('claude')
})

test('stopping confirmed Runs requires confirmation even when their agent is already off', async () => {
  const { client } = await start()
  const run = await client.startDevRun({ agent: 'claude', prompt: 'Waiting', cwd: scratch })
  await client.changeAgentAvailability({
    agent: 'claude',
    enabled: false,
    existing: 'keep',
    confirmedRunIds: [run.id],
  })
  expect(
    (await client.changeAgentAvailability({ agent: 'claude', enabled: false, existing: 'stop' }))
      .confirmationRequired,
  ).toBe(true)
  await client.changeAgentAvailability({
    agent: 'claude',
    enabled: false,
    existing: 'stop',
    confirmedRunIds: [run.id],
  })
  expect((await client.getRun(run.id)).run.state).toBe('finished')
  await client.changeAgentAvailability({ agent: 'claude', enabled: true })
  expect((await client.getRun(run.id)).run.state).toBe('finished')
})

test('disabled Task, Planning and Coordinator choices wait without blocking enabled work; re-enabling starts them', async () => {
  const { client } = await start()
  const origin = await makeOriginRepo(scratch)
  const factory = await client.addFactory({ repo: origin, key: 'NB' })
  await client.changeAgentAvailability({ agent: 'claude', enabled: false })
  const task = await client.createTask({
    factory: 'NB',
    title: 'Saved Claude choice',
    lead: { agent: 'claude' },
    start: true,
  })
  const plan = await client.startPlan({
    factory: 'NB',
    message: 'Saved planner choice',
    agent: 'claude',
  })
  const automation = await client.createAutomation({
    factory: 'NB',
    name: 'Saved Automation choice',
    agent: 'claude',
    prompt: 'Wait for instructions',
    schedule: { kind: 'every', every: 1, unit: 'hours' },
    runNow: true,
  })
  const draft = await client.draftAutomationPrompt({
    factory: 'NB',
    request: 'Write a task intake prompt',
    agent: 'claude',
  })
  expect(draft.paused).toContain('off')
  expect((await client.getAutomation(automation.id)).automation.now).toMatchObject({
    kind: 'paused',
    reason: expect.stringContaining('off'),
  })
  await client.messageCoordinator(factory.id, { text: 'Saved Coordinator choice', agent: 'claude' })
  const queued = await taskOf(client, task.id)
  expect(queued.lead?.agent).toBe('claude')
  expect(queued.status).toMatchObject({ kind: 'queued', hold: expect.stringContaining('off') })
  expect((await client.getPlan(plan.id)).plan.paused).toContain('off')
  expect((await client.coordinator(factory.id))?.error).toContain('off')
  const enabled = await client.createTask({
    factory: 'NB',
    title: 'Enabled Codex work',
    lead: { agent: 'codex' },
    start: true,
  })
  await waitUntil(async () => (await taskOf(client, enabled.id)).leadRunId, 'enabled Task Lead')
  expect((await taskOf(client, task.id)).leadRunId).toBeUndefined()
  await client.changeAgentAvailability({ agent: 'claude', enabled: true })
  await waitUntil(async () => (await taskOf(client, task.id)).leadRunId, 're-enabled Task Lead')
  await waitUntil(async () => (await client.getPlan(plan.id)).plan.runId, 're-enabled planner')
})

test('implicit defaults choose enabled agents including Antigravity and explicit choices remain intact', () => {
  const installed = { claude: true, codex: true, antigravity: true }
  expect(resolveAgentChoices(undefined, installed, ['antigravity'])).toEqual({
    lead: { agent: 'antigravity' },
    reviewer: { agent: 'antigravity' },
    planner: { agent: 'antigravity' },
  })
  expect(
    resolveAgentChoices({ lead: { agent: 'claude' }, reviewer: { agent: 'codex' } }, installed, [
      'antigravity',
    ]),
  ).toMatchObject({
    lead: { agent: 'claude' },
    reviewer: { agent: 'codex' },
    planner: { agent: 'antigravity' },
  })
})

test('queued sub-agents wait, and stopping a Task Lead confirms its other-kind sub-agents and preserves Stopped', async () => {
  const { client, info } = await start()
  const origin = await makeOriginRepo(scratch)
  await client.addFactory({ repo: origin, key: 'NB' })
  const task = await client.createTask({
    factory: 'NB',
    title: 'A Task with a reviewer',
    lead: { agent: 'claude' },
    start: true,
  })
  const leadId = await waitUntil(async () => (await taskOf(client, task.id)).leadRunId, 'Task Lead')
  const tokens = await loadRunTokens(tedPaths(home).runTokenKey)
  const lead = new DaemonClient(info, tokens.issue(leadId))
  await client.changeAgentAvailability({ agent: 'codex', enabled: false })
  const child = await lead.startSubAgent(task.id, {
    agent: 'codex',
    name: 'Review work',
    prompt: 'Wait for instructions',
  })
  expect(child.state).toBe('queued')
  await client.changeAgentAvailability({ agent: 'codex', enabled: true })
  await waitUntil(
    () =>
      client.getRun(child.id).then(
        ({ run }) => run,
        () => undefined,
      ),
    'enabled sub-agent',
  )
  const proposal = await client.changeAgentAvailability({ agent: 'claude', enabled: false })
  expect(proposal.confirmationRequired).toBe(true)
  expect(proposal.availability.additionalRuns.map((run) => run.id)).toContain(child.id)
  const confirmed = [...proposal.availability.runs, ...proposal.availability.additionalRuns].map(
    (run) => run.id,
  )
  await client.changeAgentAvailability({
    agent: 'claude',
    enabled: false,
    existing: 'stop',
    confirmedRunIds: confirmed,
  })
  expect((await client.getRun(child.id)).run.state).toBe('finished')
  expect((await taskOf(client, task.id)).status?.kind).toBe('stopped')
  await client.changeAgentAvailability({ agent: 'claude', enabled: true })
  expect((await taskOf(client, task.id)).status?.kind).toBe('stopped')
})

test('a side chat waits for its disabled kind while the retained Task Lead stays open', async () => {
  const { client } = await start()
  const origin = await makeOriginRepo(scratch)
  await client.addFactory({ repo: origin, key: 'NB' })
  const task = await client.createTask({
    factory: 'NB',
    title: 'Discuss the Task',
    lead: { agent: 'claude' },
    start: true,
  })
  const leadId = await waitUntil(async () => (await taskOf(client, task.id)).leadRunId, 'Task Lead')
  const proposal = await client.changeAgentAvailability({ agent: 'claude', enabled: false })
  await client.changeAgentAvailability({
    agent: 'claude',
    enabled: false,
    existing: 'keep',
    confirmedRunIds: proposal.availability.runs.map((run) => run.id),
  })
  await client.openSideChat(leadId)
  const chat = await client.sendSideChat(leadId, 'What is this Task doing?')
  expect(chat.state).toBe('queued')
  expect(chat.paused).toContain('off')
  expect((await client.getRun(leadId)).run.state).not.toBe('finished')
  await client.changeAgentAvailability({ agent: 'claude', enabled: true })
  await waitUntil(
    () =>
      client.getRun(chat.id).then(
        ({ run }) => run,
        () => undefined,
      ),
    're-enabled side chat',
  )
})

test('a concurrent start either joins the refreshed confirmation or is refused before launch', async () => {
  const { client } = await start()
  const first = await client.startDevRun({ agent: 'claude', prompt: 'First Run', cwd: scratch })
  const [launch, decision] = await Promise.allSettled([
    client.startDevRun({ agent: 'claude', prompt: 'Concurrent Run', cwd: scratch }),
    client.changeAgentAvailability({
      agent: 'claude',
      enabled: false,
      existing: 'stop',
      confirmedRunIds: [first.id],
    }),
  ])
  if (decision.status !== 'fulfilled') throw decision.reason
  if (launch.status === 'fulfilled') {
    expect(decision.value.confirmationRequired).toBe(true)
    expect(decision.value.availability.runs.map((run) => run.id)).toContain(launch.value.id)
    expect((await client.getRun(first.id)).run.state).not.toBe('finished')
  } else {
    expect(decision.value.confirmationRequired).toBe(false)
    expect((await client.getRun(first.id)).run.state).toBe('finished')
  }
})

test('an answered idle Task waits for an off replacement agent instead of stopping its current Run', async () => {
  const { client, info } = await start()
  const origin = await makeOriginRepo(scratch)
  await client.addFactory({ repo: origin, key: 'NB' })
  const task = await client.createTask({
    factory: 'NB',
    title: JSON.stringify({ steps: [{ endTurn: true }] }),
    lead: { agent: 'claude' },
    start: true,
  })
  const leadId = await waitUntil(async () => (await taskOf(client, task.id)).leadRunId, 'Task Lead')
  await waitUntil(async () => (await client.getRun(leadId)).run.state === 'idle', 'idle Task Lead')
  await client.changeAgentAvailability({ agent: 'codex', enabled: false })
  await client.setTaskLead(task.id, { agent: 'codex' })
  const tokens = await loadRunTokens(tedPaths(home).runTokenKey)
  const lead = new DaemonClient(info, tokens.issue(leadId))
  const question = await lead.postComment(task.id, {
    body: 'Continue with this choice?',
    choices: ['Go'],
  })
  await client.answerRequest(question.id, { action: 'answer', choice: 'Go', text: 'Go' })
  await waitUntil(async () => {
    const current = await taskOf(client, task.id)
    return (
      current.status?.kind === 'queued' &&
      'hold' in current.status &&
      current.status.hold.includes('off')
    )
  }, 'disabled replacement waiting')
  expect((await client.getRun(leadId)).run.state).not.toBe('finished')
  await client.changeAgentAvailability({ agent: 'codex', enabled: true })
  const replacement = await waitUntil(async () => {
    const current = await taskOf(client, task.id)
    return current.leadRunId && current.leadRunId !== leadId ? current.leadRunId : undefined
  }, 'enabled replacement Task Lead')
  expect((await client.getRun(replacement)).run.agent).toBe('codex')
})
