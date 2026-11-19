import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type BrowserCommand, DaemonClient, readDaemonInfo, tedPaths } from '@ted/protocol'
import { afterEach, expect, expectTypeOf, test, vi } from 'vitest'
import type { Apps } from '../src/apps/apps.ts'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import type { AppsArea } from '../src/store/apps.ts'
import type { TedStore } from '../src/store/index.ts'
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
import { approveAppsOutsideSandbox } from './support/outside-sandbox-approvals.ts'

expectTypeOf<TedStore>().toExtend<AppsArea>()

const validation = {
  after: 0,
  release: undefined as ((error?: Error) => void) | undefined,
}
function releaseValidation(error?: Error) {
  validation.release?.(error)
}
function pauseValidation(apps: Apps): Apps {
  return {
    ...apps,
    list: async (...args) => {
      const result = await apps.list(...args)
      if (validation.after > 0 && --validation.after === 0) {
        await new Promise<void>((resolve, reject) => {
          validation.release = (error) => (error ? reject(error) : resolve())
        })
      }
      return result
    },
  }
}

let daemon: RunningDaemon | undefined
let cleanup: (() => Promise<void>) | undefined
let scratch: string | undefined
let home = ''
afterEach(async () => {
  validation.release?.()
  validation.release = undefined
  validation.after = 0
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
      '      - name: Other',
      `        run: "'${process.execPath}' '${stub}'"`,
    ].join('\n'),
  })
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    apps: { pollMs: 50 },
    wrap: { apps: pauseValidation },
  })
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('Daemon info missing')
  let app = new DaemonClient(info, info.token, { appKey: daemon.appToken })
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
  await approveAppsOutsideSandbox(app, task)
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
  for (const action of ['stop', 'restart'] as const) {
    await app.startApp(task.id, { name: 'Other' })
    const unchangedPoll = app.pollBrowser('owner')
    const unchangedRequest = app.browserCommand(task.id, { action: 'snapshot' })
    const unchangedResult = unchangedRequest.then(
      (result) => ({ result }),
      (error: Error) => ({ error: error.message }),
    )
    const unchanged = await unchangedPoll
    if (!unchanged) throw new Error('Missing unchanged App command')
    if (action === 'stop') await app.stopApp(task.id, { name: 'Other' })
    else await app.restartApp(task.id, { name: 'Other' })
    await app.replyBrowser('owner', unchanged.id, { result: { text: 'Still active' } })
    expect(await unchangedResult).toEqual({ result: { text: 'Still active' } })
  }
  await waitUntil(
    async () =>
      (await app.listApps(task.id)).find((a) => a.name === 'Other' && a.state === 'running'),
    'other App',
  )
  for (const outcome of ['failure', 'success']) {
    validation.after = 2
    validation.release = undefined
    const obsoletePoll = app.pollBrowser(`old-${outcome}`)
    const obsoleteRequest = app
      .browserCommand(task.id, request)
      .catch((error: Error) => error.message)
    await vi.waitFor(() => expect(validation.release).toBeTypeOf('function'))
    const newerPoll = app.pollBrowser(`new-${outcome}`)
    const newerRequest = app.browserCommand(task.id, { action: 'open', app: { name: 'Other' } })
    const newerResult = newerRequest.then(
      (result) => ({ result }),
      (error: Error) => ({ error: error.message }),
    )
    const newer = await newerPoll
    if (!newer) throw new Error('Missing newer command')
    expect(await obsoleteRequest).toMatch(/connection changed/)
    releaseValidation(
      outcome === 'failure' ? new Error('Obsolete App validation failed') : undefined,
    )
    expect(await obsoletePoll).toBeNull()
    expect(await app.pollBrowser(`new-${outcome}`)).toBeNull()
    await app.replyBrowser(`new-${outcome}`, newer.id, {
      result: { text: 'Newer command completed' },
    })
    expect(await newerResult).toEqual({ result: { text: 'Newer command completed' } })
  }
  validation.after = 2
  validation.release = undefined
  const invalidPoll = app.pollBrowser('invalid-owner')
  const invalidRequest = app.browserCommand(task.id, request).catch((error: Error) => error.message)
  await vi.waitFor(() => expect(validation.release).toBeTypeOf('function'))
  releaseValidation(new Error('Current App validation failed'))
  expect(await invalidPoll).toBeNull()
  expect(await invalidRequest).toMatch(/no longer available/)
  const restorePoll = app.pollBrowser('owner')
  const restore = app.browserCommand(task.id, request)
  const restored = await restorePoll
  if (!restored) throw new Error('Missing restore command')
  await app.replyBrowser('owner', restored.id, { result: {} })
  await restore
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
  expect((await app.listTasks()).find((t) => t.id === task.id)?.attachments).toEqual([])
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
  await app.postComment(other.id, { body: 'Shared capture', attachments: [attachment] })
  const unpostedPoll = app.pollBrowser('owner')
  const unpostedRequest = run.call('POST', `/tasks/${task.id}/browser`, { action: 'screenshot' })
  const unpostedCommand = (await unpostedPoll) as BrowserCommand
  const unposted = await app.uploadBrowserCapture(
    'owner',
    unpostedCommand.id,
    new Uint8Array([1, 2, 3]),
  )
  expect((await unpostedRequest).status).toBe(200)
  const stopPoll = app.pollBrowser('owner')
  let settled = false
  const pending = run
    .call('POST', `/tasks/${task.id}/browser`, { action: 'snapshot' })
    .then((result) => {
      settled = true
      return result
    })
  const stopped = (await stopPoll) as BrowserCommand
  await app.stopApp(task.id, { name: 'Web' })
  await app.replyBrowser('owner', stopped.id, { result: { text: 'Late result' } })
  expect(settled).toBe(false)
  expect(await app.pollBrowser('owner')).toMatchObject({ id: stopped.id, canceled: true })
  await app.replyBrowser('owner', stopped.id, { canceled: true })
  expect((await pending).status).toBe(409)
  await expect(app.replyBrowser('owner', stopped.id, { result: {} })).rejects.toThrow(/expired/)
  expect((await run.call('POST', `/tasks/${task.id}/browser`, { action: 'snapshot' })).status).toBe(
    409,
  )
  await daemon.stop()
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    apps: { pollMs: 50 },
    wrap: { apps: pauseValidation },
  })
  const restartedInfo = await readDaemonInfo(home)
  if (!restartedInfo) throw new Error('Missing restarted daemon')
  app = new DaemonClient(restartedInfo, restartedInfo.token, { appKey: daemon.appToken })
  expect(await app.readBrowserCapture(task.id, unposted.hash)).toEqual({ data: 'AQID' })
  await app.archiveTask(task.id)
  await app.deleteTask(task.id)
  const capturedFile = (hash: string) => path.join(tedPaths(home).attachments, `${hash}.png`)
  expect(
    await stat(capturedFile(unposted.hash)).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
  expect(
    await stat(capturedFile(attachment.hash)).then(
      () => true,
      () => false,
    ),
  ).toBe(true)
  await app.deleteTask(other.id)
  expect(
    await stat(capturedFile(attachment.hash)).then(
      () => true,
      () => false,
    ),
  ).toBe(false)

  const last = await app.createTask({ factory: 'NB', title: '{"steps":[{"endTurn":true}]}' })
  await app.startTask(last.id)
  await waitUntil(
    async () => (await app.listTasks()).find((t) => t.id === last.id && t.leadRunId),
    'last Task Lead',
  )
  await app.startApp(last.id, { name: 'Web' })
  await waitUntil(
    async () => (await app.listApps(last.id)).find((a) => a.state === 'running'),
    'last App',
  )
  const openPoll = app.pollBrowser('restarted-owner')
  const reopened = app.browserCommand(last.id, request)
  const openCommand = await openPoll
  if (!openCommand) throw new Error('No open command')
  await app.replyBrowser('restarted-owner', openCommand.id, { result: {} })
  await reopened
  const lastPoll = app.pollBrowser('restarted-owner')
  const lastRequest = app.browserCommand(last.id, { action: 'screenshot' })
  const lastCommand = await lastPoll
  if (!lastCommand) throw new Error('No capture command')
  const factoryCapture = await app.uploadBrowserCapture(
    'restarted-owner',
    lastCommand.id,
    new Uint8Array([4, 5, 6]),
  )
  await lastRequest
  const factory = (await app.listFactories()).find((f) => f.key === 'NB')
  if (!factory) throw new Error('Missing Factory')
  await app.removeFactory(factory.id, { key: 'NB', closePullRequests: false })
  expect(
    await stat(capturedFile(factoryCapture.hash)).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
}, 90_000)
