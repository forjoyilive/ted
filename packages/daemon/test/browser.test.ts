import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type BrowserCommand, DaemonClient, readDaemonInfo, tedPaths } from '@ted/protocol'
import { afterEach, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import {
  api,
  commitToOrigin,
  killAppHosts,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'

let daemon: RunningDaemon | undefined
let cleanup: (() => Promise<void>) | undefined
let scratch: string | undefined
let home = ''
afterEach(async () => {
  await daemon?.stop()
  await killAppHosts(home)
  await killRunHosts(home)
  await cleanup?.()
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

test('only its Task can command the browser; the app bridge completes commands once and scopes captures', async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-browser-'))
  const origin = await makeOriginRepo(scratch)
  const stub = fileURLToPath(new URL('./fixtures/stub-app.ts', import.meta.url))
  await commitToOrigin(scratch, {
    '.ted/workflow.yaml': [
      'version: 1',
      'order: [intake, work, merge]',
      'repos:',
      '  - name: widgets',
      '    apps:',
      '      - name: Web',
      `        run: "'${process.execPath}' '${stub}'"`,
    ].join('\n'),
  })
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    apps: { pollMs: 50 },
  })
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('Daemon info missing')
  const app = new DaemonClient(info, info.token, { appKey: daemon.appToken })
  await app.addFactory({ repo: origin, key: 'NB' })
  const task = await app.createTask({ factory: 'NB', title: '{"steps":[{"endTurn":true}]}' })
  await app.startTask(task.id)
  const current = await waitUntil(async () => {
    const found = (await app.listTasks()).find((t) => t.id === task.id)
    return found?.leadRunId ? found : undefined
  }, 'Task Lead')
  const key = await loadRunTokens(tedPaths(home).runTokenKey)
  const run = api(daemon.port, key.issue(current.leadRunId ?? ''))
  const file = api(daemon.port, info.token)
  expect((await run.call('POST', '/browser/poll', { session: 'owner' })).status).toBe(403)
  expect((await file.call('POST', '/browser/poll', { session: 'owner' })).status).toBe(403)
  expect((await run.call('POST', `/tasks/${task.id}/browser`, { action: 'open' })).status).toBe(400)
  const other = await app.createTask({ factory: 'NB', title: 'Other' })
  expect(
    (await run.call('POST', `/tasks/${other.id}/browser`, { action: 'open', app: { name: 'Web' } }))
      .status,
  ).toBe(403)
  await app.startApp(task.id, { name: 'Web' })
  await waitUntil(
    async () => (await app.listApps(task.id)).find((a) => a.state === 'running'),
    'web App',
  )
  const request = { action: 'open' as const, app: { name: 'Web' } }
  expect((await run.call('POST', `/tasks/${task.id}/browser`, request)).status).toBe(503)
  const polling = app.pollBrowser('owner')
  const opening = run.call('POST', `/tasks/${task.id}/browser`, request)
  const command = (await polling) as BrowserCommand
  expect(command.taskId).toBe(task.id)
  expect(command.runId).toBe(current.leadRunId)
  expect(command.expiresAt).toBeGreaterThan(Date.now())
  expect(
    (await run.call('POST', `/browser/${command.id}/reply`, { session: 'owner', result: {} }))
      .status,
  ).toBe(403)
  await app.replyBrowser('owner', command.id, { result: { url: command.app.url ?? '' } })
  expect((await opening).status).toBe(200)
  await expect(app.replyBrowser('owner', command.id, { result: {} })).rejects.toThrow(/expired/)
  const capturePoll = app.pollBrowser('owner')
  const capturing = run.call('POST', `/tasks/${task.id}/browser`, { action: 'screenshot' })
  const shot = (await capturePoll) as BrowserCommand
  const attachment = await app.uploadBrowserCapture(
    'owner',
    shot.id,
    new Uint8Array([137, 80, 78, 71]),
  )
  expect((await capturing).body).toMatchObject({ attachment })
  expect(await app.readBrowserCapture(task.id, attachment.hash)).toEqual({ data: 'iVBORw==' })
  expect(
    (await run.call('GET', `/tasks/${other.id}/browser/captures/${attachment.hash}`)).status,
  ).toBe(403)
  expect(
    (await app.listComments(task.id)).some((c) =>
      c.attachments?.some((a) => a.hash === attachment.hash),
    ),
  ).toBe(false)
  expect(
    (
      await run.call('POST', `/tasks/${task.id}/comments`, {
        body: 'Capture',
        attachments: [attachment],
      })
    ).status,
  ).toBe(201)
  const stopPoll = app.pollBrowser('owner')
  const pending = run.call('POST', `/tasks/${task.id}/browser`, { action: 'snapshot' })
  const stopped = (await stopPoll) as BrowserCommand
  await app.stopApp(task.id, { name: 'Web' })
  expect((await pending).status).toBe(409)
  await expect(app.replyBrowser('owner', stopped.id, { result: {} })).rejects.toThrow(/expired/)
  expect((await run.call('POST', `/tasks/${task.id}/browser`, { action: 'snapshot' })).status).toBe(
    409,
  )
}, 90_000)
