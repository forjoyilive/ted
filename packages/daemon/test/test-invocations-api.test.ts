import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DaemonClient, readDaemonInfo, type Task, tedPaths } from '@ted/protocol'
import { expect, test } from 'vitest'
import { runCli } from '../../cli/src/cli.ts'
import { startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import {
  api,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  rawRequest,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'

test('reporting credentials only record their invocation, Run callers own their Task, and CLI reports coverage', async () => {
  const { home, cleanup } = await makeTempHome()
  const scratch = await mkdtemp(path.join(tmpdir(), 'ted-reporting-api-'))
  const daemon = await startDaemon({ home, version: 'test', claudeBin: stubClaudePath })
  try {
    const app = api(daemon.port, { appKey: daemon.appToken })
    const origin = await makeOriginRepo(scratch)
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
    })
    expect((await app.call('POST', '/dev/factories', { repo: origin, key: 'NB' })).status).toBe(201)
    const created = await app.call('POST', '/tasks', {
      title: JSON.stringify({
        steps: [{ waitFor: path.join(scratch, 'hold') }, { endTurn: true }],
      }),
      factory: 'NB',
      start: true,
    })
    expect(created.status).toBe(201)
    const task = created.body as Task
    const other = (
      await app.call('POST', '/tasks', {
        title: JSON.stringify({
          steps: [{ waitFor: path.join(scratch, 'hold-other') }, { endTurn: true }],
        }),
        factory: 'NB',
      })
    ).body as Task
    const runId = await waitUntil(async () => {
      const current = (await app.call('GET', '/tasks')).body as Task[]
      return current.find((t) => t.id === task.id)?.leadRunId
    }, 'Task Lead starts')
    const tokens = await loadRunTokens(tedPaths(home).runTokenKey)
    const token = tokens.issue(runId)
    const lead = api(daemon.port, token)
    const input = { id: randomUUID(), supported: true, label: 'Tests' }
    const root = `/tasks/${task.id}/test-invocations`
    for (const method of ['GET', 'POST'])
      expect(
        (
          await lead.call(
            method,
            `/tasks/${other.id}/test-invocations`,
            method === 'POST' ? input : undefined,
          )
        ).status,
      ).toBe(403)
    const registration = await lead.call('POST', root, input)
    expect(registration.status).toBe(200)
    expect((await lead.call('POST', root, input)).body).toEqual(registration.body)
    expect(
      (
        await lead.call('POST', root, {
          ...input,
          id: randomUUID(),
          checkRunId: randomUUID(),
          position: 0,
        })
      ).status,
    ).toBe(403)
    const { invocation, token: reportingToken } = registration.body
    const reporter = api(daemon.port, reportingToken)
    const reportPath = `/test-invocations/${input.id}/reports`
    const report = { sequence: 0, kind: 'wait-start', at: invocation.registeredAt }
    expect((await lead.call('POST', reportPath, report)).status).toBe(403)
    expect(
      (
        await api(daemon.port, tokens.issue(`test-report:${input.id}`)).call(
          'POST',
          reportPath,
          report,
        )
      ).status,
    ).toBe(403)
    for (const kind of [['wait-start'], ['wait-end'], ['finished'], {}, true, null]) {
      expect((await reporter.call('POST', reportPath, { ...report, kind })).status).toBe(400)
    }
    expect((await reporter.call('POST', reportPath, report)).status).toBe(200)
    expect((await reporter.call('POST', reportPath, report)).status).toBe(200)
    expect((await reporter.call('POST', reportPath, { ...report, sequence: 2 })).status).toBe(409)
    expect((await reporter.call('POST', reportPath, { ...report, text: 'secret' })).status).toBe(
      400,
    )
    expect(
      (await reporter.call('POST', `/test-invocations/${randomUUID()}/reports`, report)).status,
    ).toBe(403)
    for (const [method, route, body] of [
      ['GET', root, undefined],
      ['POST', root, input],
      ['POST', `/tasks/${task.id}/checks`, {}],
      ['POST', `/tasks/${task.id}/outcome`, { outcome: 'advance' }],
      ['POST', '/comments/fake/answer', { action: 'approve' }],
      ['PATCH', '/settings', {}],
      ['POST', '/dev/runs', { prompt: 'execute code', cwd: scratch }],
      ['GET', '/caller', undefined],
    ] as const)
      expect((await reporter.call(method, route, body)).status, route).toBe(403)
    const blockedBrowser = await rawRequest(daemon.port, {
      method: 'POST',
      path: reportPath,
      headers: { authorization: `Bearer ${reportingToken}`, origin: 'https://example.com' },
      body: JSON.stringify(report),
    })
    expect(blockedBrowser.status).toBe(403)
    expect(
      (
        await reporter.call('POST', reportPath, {
          sequence: 1,
          kind: 'canceled',
          at: invocation.registeredAt + 10,
        })
      ).status,
    ).toBe(200)
    const summary = (await lead.call('GET', root)).body
    expect(summary.invocations[0]).toMatchObject({
      coverage: 'reported',
      outcome: 'canceled',
      confirmedWaitMs: 10,
    })
    expect(JSON.stringify(summary)).not.toContain(reportingToken)
    expect(summary.directCommands).toContain('outside coverage')
    const info = await readDaemonInfo(home)
    if (!info) throw new Error('no daemon info')
    const client = new DaemonClient(info, token)
    const output: string[] = []
    expect(
      await runCli(['test-invocations', '--task', task.id], {
        home,
        env: { ...process.env, TED_TASK: task.id },
        connect: async (_home, work) => work(client),
        stdout: (s) => output.push(s),
      }),
    ).toBe(0)
    expect(JSON.parse(output.join(''))).toEqual(summary)
    expect(
      await new DaemonClient(info, reportingToken).reportTestInvocation(input.id, {
        sequence: 1,
        kind: 'canceled',
        at: invocation.registeredAt + 10,
      }),
    ).toBe(true)
    expect((await app.call('POST', `/tasks/${task.id}/delete`, {})).status).toBe(200)
    expect((await app.call('POST', `/tasks/${other.id}/start`, {})).status).toBe(200)
    const replacementRun = await waitUntil(async () => {
      const tasks = (await app.call('GET', '/tasks')).body as Task[]
      return tasks.find((t) => t.id === other.id)?.leadRunId
    }, 'replacement Task Lead starts')
    const replacementLead = api(daemon.port, tokens.issue(replacementRun))
    const replacement = await replacementLead.call(
      'POST',
      `/tasks/${other.id}/test-invocations`,
      input,
    )
    expect(replacement.status).toBe(200)
    expect(replacement.body.token).not.toBe(reportingToken)
    const replacementReport = {
      sequence: 0,
      kind: 'finished',
      at: replacement.body.invocation.registeredAt,
    }
    expect((await reporter.call('POST', reportPath, replacementReport)).status).toBe(403)
    expect(
      (await api(daemon.port, replacement.body.token).call('POST', reportPath, replacementReport))
        .status,
    ).toBe(200)
  } finally {
    await daemon.stop()
    await killRunHosts(home, { waitForStart: true })
    await cleanup()
    await rm(scratch, { recursive: true, force: true })
  }
})
