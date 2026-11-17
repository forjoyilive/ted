import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  CheckRun,
  Comment,
  FailureCase,
  SendBack,
  Task,
  ValidationObligations,
} from '@ted/protocol'
import { tedPaths } from '@ted/protocol'
import type { JsonObject } from '@ted/protocol/parse'
import { expect } from 'vitest'
import { startDaemon } from '../../src/index.ts'
import { loadRunTokens } from '../../src/run-token.ts'
import type { openStore } from '../../src/store/index.ts'
import { api, stubClaudePath, stubCodexPath, waitUntil } from '../helpers.ts'
import { type Client, ctx, getTask, start } from '../merge-harness.ts'

export const workGate = ['  work:', '    gate: true']
export const brief = {
  text: '## Goal\nVerify the change.\n\n## Decisions so far\nNone.\n\n## Current state\nWork is done.\n\n## Open questions\nNone.\n\n## Next step\nValidate.',
}

export const usual = [
  '      - { name: Tests, run: "echo broken; exit 1" }',
  '      - { name: Lint, run: "echo linted" }',
]
const usualOrder = 'intake, work, validate, review'
export const long = 120_000

export function boot(checks = usual, order = usualOrder, loopCheck: false | number = false) {
  return start({
    order,
    daemon: { codexBin: stubCodexPath },
    workflow: [
      'stages:',
      ...(order.indexOf('work') < order.indexOf('validate') ? workGate : []),
      '  validate:',
      '    max_back: 2',
      `    loop_check: ${loopCheck}`,
      '    checks:',
      ...checks,
    ],
  })
}

export async function walk(
  client: Client,
  order = usualOrder,
  loopCheck: false | number = false,
  endMessages = false,
  verdict = 'converging',
) {
  const task = await client.ok<Task>('POST', '/tasks', {
    title: JSON.stringify({
      steps: [
        ...(endMessages ? [{ everyMessage: [{ endTurn: true }] }] : []),
        ...(loopCheck === false ? [] : [{ say: `Verdict: ${verdict}` }]),
        { endTurn: true },
      ],
    }),
    factory: 'NB',
    start: true,
  })
  const initial = await waitUntil(async () => {
    const t = await getTask(client, task.id)
    return t.runs[0]?.state === 'idle' ? t : undefined
  }, 'idle Task Lead')
  const tokens = await loadRunTokens(tedPaths(ctx.home).runTokenKey)
  const lead = api(ctx.daemon?.port ?? 0, tokens.issue(initial.leadRunId ?? ''))
  const root = `/tasks/${task.id}`
  const post = async <T>(route: string, body: JsonObject = {}): Promise<T> => {
    if (
      route === '/outcome' &&
      body.outcome === 'advance' &&
      (await getTask(client, task.id)).stage === 'work'
    )
      await lead.call('POST', `${root}/brief`, brief)
    const res = await lead.call('POST', root + route, body)
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300)
    const gate = (res.body as { request?: Comment }).request
    if (route === '/outcome' && gate?.gate && gate.stage === 'work')
      await client.ok('POST', `/comments/${gate.id}/answer`, { action: 'approve' })
    return res.body as T
  }
  const working = await waitUntil(async () => (await getTask(client, task.id)).repos[0], 'worktree')
  await writeFile(path.join(working.worktree, 'work.txt'), 'implemented\n')
  await post('/outcome', { outcome: 'advance' })
  if (order.indexOf('work') < order.indexOf('validate'))
    await post('/outcome', { outcome: 'advance' })
  const cases = () => client.ok<FailureCase[]>('GET', `${root}/failures`)
  const failure = (count = 1) =>
    waitUntil(
      async () => {
        const values = (await cases()).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        return values.length >= count ? values.at(-1) : undefined
      },
      'failure case',
      60_000,
    )
  const one = await failure()
  if (order.indexOf('work') < order.indexOf('validate') && verdict === 'converging')
    await waitUntil(
      async () => (await getTask(client, task.id)).stage === 'work',
      'the failed Check to return the Task to Work',
      60_000,
    )
  const assess = (value: FailureCase, assessment = 'unrelated') =>
    post<FailureCase>(`/failures/${value.id}/assessments`, {
      assessment,
      recommendation: 'Evidence shows an unrelated failure. Recommend accepting this execution.',
    })
  const ask = async (value: FailureCase, assessment = 'unrelated') => {
    await assess(value, assessment)
    return post<FailureCase>(`/failures/${value.id}/decision`)
  }
  const answer = (value: FailureCase, choice: string) =>
    client.call('POST', `/comments/${value.decisions.at(-1)?.commentId}/answer`, {
      action: 'answer',
      choice,
    })
  const obligations = () =>
    client.ok<ValidationObligations>('GET', `${root}/validation-obligations`)
  const runs = () => client.ok<CheckRun[]>('GET', `${root}/check-runs`)
  const backs = () => client.ok<SendBack[]>('GET', `${root}/send-backs`)
  const accept = async (value = one, assessment = 'unrelated') => {
    const decision = await ask(value, assessment)
    const response = await answer(decision, 'Accept this failure')
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    return decision
  }
  const validated = () =>
    waitUntil(async () => (await obligations()).satisfied, 'Validate’s Checks to finish')
  return {
    client,
    task,
    lead,
    root,
    post,
    cases,
    failure,
    one,
    assess,
    ask,
    answer,
    obligations,
    runs,
    backs,
    accept,
    validated,
  }
}

export type Scene = Awaited<ReturnType<typeof walk>>

export function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing value')
  return value
}

export const setup = async (
  checks = usual,
  order = usualOrder,
  loopCheck: false | number = false,
  endMessages = false,
) => walk(await boot(checks, order, loopCheck), order, loopCheck, endMessages)

export function backInValidate(store: Awaited<ReturnType<typeof openStore>>, taskId: string) {
  const { stageFile, layers } = required(
    store.listStageEntries(taskId).findLast((e) => e.stage === 'validate'),
  )
  store.changeStage(taskId, 'validate', {
    ...(stageFile && { stageFile }),
    layers,
    order: required(store.recordedStages(taskId)),
  })
  const visit = required(store.listStageEntries(taskId).at(-1)?.at)
  store.failures.saveProgress({ ...required(store.failures.progress(taskId)), visit })
}

export async function restart(mergePollMs?: number) {
  await ctx.daemon?.stop()
  ctx.daemon = await startDaemon({
    home: ctx.home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    ...(mergePollMs !== undefined && { mergePollMs }),
  })
  const client = api(ctx.daemon.port, { appKey: ctx.daemon.appToken })
  return {
    ...client,
    port: ctx.daemon.port,
    async read<T>(route: string): Promise<T> {
      const response = await client.call('GET', route)
      expect(response.status).toBe(200)
      return response.body as T
    },
  }
}
