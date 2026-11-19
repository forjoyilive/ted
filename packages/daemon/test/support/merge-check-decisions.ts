import type { CheckRun, Comment, FailureCase, Task, ValidationObligations } from '@ted/protocol'
import { tedPaths } from '@ted/protocol'
import { expect } from 'vitest'
import { startDaemon } from '../../src/index.ts'
import { loadRunTokens } from '../../src/run-token.ts'
import { api, commitToOrigin, hostsStarted, stubClaudePath, waitUntil } from '../helpers.ts'
import {
  approve,
  type Client,
  commitStep,
  ctx,
  getTask,
  ghCalls,
  leadSteps,
  start,
  toSignoff,
} from '../merge-harness.ts'
import { offeredChoice } from './failure-choice.ts'

export const long = 120_000
export const checks = [
  '      - { name: Prefix, run: "echo prefix >> stub-prefix" }',
  '      - { name: First, run: "test ! -e base-only || test -e stub-first-fixed" }',
  '      - { name: Later, run: "test ! -e base-only || test -e stub-later-fixed" }',
]

export async function rebased(gate = false, ci = false) {
  const client = await start({
    ...(ci && { files: { '.github/workflows/ci.yml': 'on: pull_request\n' } }),
    merge: {
      mergeState: 'BEHIND',
      ...(ci && {
        checks: [{ name: 'Required', status: 'COMPLETED', conclusion: 'SUCCESS', required: true }],
      }),
    },
    workflow: ['stages:', '  merge:', `    gate: ${gate}`, '  validate:', '    checks:', ...checks],
  })
  const { task, signoff } = await toSignoff(client, {
    title: leadSteps(client, `[ -e stub-built ] || { ${commitStep.run[2]}; touch stub-built; }`),
  })
  await commitToOrigin(ctx.scratch, { 'base-only': 'A base change breaks existing Checks.\n' })
  await approve(client, signoff)
  const failure = await failed(client, task)
  return { client, task, failure }
}

export const runs = (client: Client, task: Task) =>
  client
    .ok<CheckRun[]>('GET', `/tasks/${task.id}/check-runs`)
    .then((rs) => rs.filter((r) => r.trigger === 'merge'))
export const cases = (client: Client, task: Task) =>
  client.ok<FailureCase[]>('GET', `/tasks/${task.id}/failures`)
export const comments = (client: Client, task: Task) =>
  client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)
export const obligations = (client: Client, task: Task) =>
  client.ok<ValidationObligations>('GET', `/tasks/${task.id}/validation-obligations`)

export async function failed(client: Client, task: Task, count = 1) {
  return waitUntil(async () => {
    const values = await cases(client, task)
    const t = await getTask(client, task.id)
    const execution = (await runs(client, task)).at(-1)
    return values.length === count &&
      !t.markers.some((m) => m.kind === 'test-activity' && m.source === 'checks')
      ? values.find(
          (value) =>
            value.source.kind === 'post-rebase-check' && value.source.checkRunId === execution?.id,
        )
      : undefined
  }, 'post-rebase failure ready for diagnosis')
}

export async function lead(client: Client, task: Task) {
  const t = await getTask(client, task.id)
  const tokens = await loadRunTokens(tedPaths(ctx.home).runTokenKey)
  return api(ctx.daemon?.port ?? 0, tokens.issue(t.leadRunId ?? ''))
}

export async function assess(
  client: Client,
  task: Task,
  failure: FailureCase,
  assessment = 'unrelated',
) {
  const agent = await lead(client, task)
  const root = `/tasks/${task.id}/failures/${failure.id}`
  const result = await agent.call('POST', `${root}/assessments`, {
    assessment,
    choice: offeredChoice(failure, (await getTask(client, task.id)).stage),
    recommendation:
      assessment === 'regression'
        ? 'Fix this Task and revalidate.'
        : 'Accept this known base failure and continue the remaining Checks.',
  })
  expect(result.status, JSON.stringify(result.body)).toBe(200)
  return agent
}

export async function ask(client: Client, task: Task, failure: FailureCase) {
  const agent = await assess(client, task, failure)
  const response = await agent.call('POST', `/tasks/${task.id}/failures/${failure.id}/decision`)
  expect(response.status, JSON.stringify(response.body)).toBe(201)
  return (response.body as FailureCase).decisions.at(-1)?.commentId ?? ''
}

export async function resolve(
  client: Client,
  task: Task,
  failure: FailureCase,
  requestId: string,
  resolution: 'accepted' | 'retry' | 'fix',
) {
  return client.call('POST', `/tasks/${task.id}/failures/${failure.id}/resolve`, {
    requestId,
    resolution,
  })
}

export async function polls(client: Client) {
  const before = (await ghCalls()).filter(
    (c) => c.args[0] === 'api' && c.args[1] === 'graphql',
  ).length
  await waitUntil(
    async () =>
      (await ghCalls()).filter((c) => c.args[0] === 'api' && c.args[1] === 'graphql').length >=
      before + 3,
    'three later GitHub polls',
  )
  expect(ctx.daemon).toBeDefined()
  return client
}

export async function restart(previous: Client): Promise<Client> {
  await hostsStarted(ctx.home)
  await ctx.daemon?.stop()
  ctx.daemon = await startDaemon({
    home: ctx.home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    mergePollMs: 100,
  })
  const client = api(ctx.daemon.port, { appKey: ctx.daemon.appToken })
  const ok: Client['ok'] = async (method, route, body) => {
    const response = await client.call(method, route, body)
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300)
    return response.body
  }
  return { ...previous, ...client, ok }
}
