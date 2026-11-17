import type { CheckRun, InboxItem, Task, TaskGates } from '@ted/protocol'
import { tedPaths } from '@ted/protocol'
import type { Json, JsonObject } from '@ted/protocol/parse'
import { expect } from 'vitest'
import { loadRunTokens } from '../../src/run-token.ts'
import { api, waitUntil } from '../helpers.ts'
import {
  brief,
  type Client,
  commitStep,
  ctx,
  getTask,
  mergeAdvance,
  merges,
  run,
} from '../merge-harness.ts'

export const settingsStep = {
  run: [
    'sh',
    '-c',
    'echo "# reviewed" >> .ted/workflow.yaml && git add .ted && git -c user.name=T -c user.email=t@example.com commit -qm settings',
  ],
}

export async function begin(
  client: Client,
  extra: JsonObject = {},
  step: Json = commitStep,
): Promise<Task> {
  const task = await client.ok<Task>('POST', '/tasks', {
    title: JSON.stringify({
      steps: [
        { everyMessage: [{ run: ['sh', '-c', mergeAdvance] }, { endTurn: true }] },
        step,
        { endTurn: true },
      ],
    }),
    factory: 'NB',
    ...extra,
  })
  await client.ok('POST', `/tasks/${task.id}/start`)
  return task
}

export async function lead(client: Client, task: Task) {
  const runId = await waitUntil(async () => {
    const { leadRunId } = await getTask(client, task.id)
    if (!leadRunId) return undefined
    return (await client.getRun(leadRunId)).run.state === 'idle' ? leadRunId : undefined
  }, 'an idle Task Lead')
  const token = (await loadRunTokens(tedPaths(ctx.home).runTokenKey)).issue(runId)
  return api(ctx.daemon?.port ?? 0, token)
}

export async function advance(client: Client, task: Task) {
  const run = await lead(client, task)
  expect((await run.call('POST', `/tasks/${task.id}/brief`, { text: brief })).status).toBe(201)
  return waitUntil(async () => {
    const res = await run.call('POST', `/tasks/${task.id}/outcome`, { outcome: 'advance' })
    return JSON.stringify(res.body).includes('checks; wait for their results') ? undefined : res
  }, 'the Checks to finish')
}

export async function advanceTo(client: Client, task: Task, stage: string) {
  const res = await advance(client, task)
  if (stage === 'validate' && /before \S+ leaves Work/.test(JSON.stringify(res.body))) {
    await waitUntil(
      async () => (await getTask(client, task.id)).stage === stage || undefined,
      'the Checks to pass and the Task to reach Validate',
    )
    return
  }
  expect(res.body).toMatchObject({ task: { stage } })
}

export const gateRequests = async (client: Client, task: Task) =>
  (await client.ok<InboxItem[]>('GET', '/inbox')).filter(
    (item) => item.task.id === task.id && item.request.gate !== undefined,
  )

export const overnight = (client: Client, on: boolean) =>
  client.ok('PATCH', '/settings', { overnightMode: on })

export const gates = (client: Client, task: Task) =>
  client.ok<TaskGates>('GET', `/tasks/${task.id}/gates`)

export const row = (view: TaskGates, stage: string) => view.rows.find((r) => r.stage === stage)

export const kept = (stage: string) =>
  `Autopilot is on, but this Task changes .ted/, so its ${stage} Sign-Off stays on`

export async function verifyCurrent(client: Client, task: Task) {
  const token = await lead(client, task)
  const id = await waitUntil(async () => {
    const response = await token.call('POST', `/tasks/${task.id}/checks`, {})
    if (response.status === 409 && JSON.stringify(response.body).includes('already moving'))
      return undefined
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    return (response.body as CheckRun).id
  }, 'start current coverage when the merge watcher releases the Task')
  await waitUntil(async () => {
    const runs = await client.ok<CheckRun[]>('GET', `/tasks/${task.id}/check-runs`)
    return runs.find((r) => r.id === id)?.outcome === 'passed'
  }, 'fresh coverage for the changed worktree')
}

export const open = { order: 'intake, work, validate, merge' }

export const ci = { '.github/workflows/ci.yml': 'on: pull_request\n' }
export const pending = { checks: [{ name: 'test', status: 'IN_PROGRESS' }] }
export const passed = { checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] }
export const waitingForCi = (client: Client, task: Task) =>
  waitUntil(async () => {
    const current = await getTask(client, task.id)
    return current.stage === 'merge' && current.status?.kind === 'waiting-for-github'
      ? current
      : undefined
  }, 'Waiting for CI')
export const lateSettingsCommit = (worktree: string) =>
  run('sh', ['-c', settingsStep.run[2] ?? ''], { cwd: worktree })
export const mergeCard = (client: Client, task: Task) =>
  waitUntil(
    async () => (await gateRequests(client, task)).find((i) => i.request.stage === 'merge'),
    'the Merge sign-off',
  )

export const plainMerges = async () =>
  (await merges()).filter((m) => !m.includes('--auto') && !m.includes('--disable-auto'))
