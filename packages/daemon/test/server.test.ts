import { readdir, readFile, stat } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { appClient, appHeaders, makeTempHome, rawRequest, tokenFor } from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await cleanup()
})

describe('daemon HTTP API', () => {
  test('/healthz answers ok and the version without a token', async () => {
    daemon = await startDaemon({ home, version: '9.9.9' })

    const res = await rawRequest(daemon.port, { path: '/healthz' })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ status: 'ok', version: '9.9.9' })
  })

  test('writes daemon.json with mode 0600 and a fresh token on each start', async () => {
    const file = path.join(home, 'daemon.json')

    daemon = await startDaemon({ home, version: '9.9.9' })
    const first = JSON.parse(await readFile(file, 'utf8'))
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(first).toMatchObject({ port: daemon.port, pid: process.pid, version: '9.9.9' })
    expect(first.token).toMatch(/^[0-9a-f]{64}$/)
    await daemon.stop()

    daemon = await startDaemon({ home, version: '9.9.9' })
    const second = JSON.parse(await readFile(file, 'utf8'))
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(second.token).not.toBe(first.token)
  })

  test('refuses /tasks and /events without the token or with a wrong one', async () => {
    daemon = await startDaemon({ home, version: '9.9.9' })

    for (const route of ['/tasks', '/events']) {
      const none = await rawRequest(daemon.port, { path: route })
      const wrong = await rawRequest(daemon.port, {
        path: route,
        headers: { authorization: `Bearer ${'0'.repeat(64)}` },
      })

      expect(none.status, route).toBe(401)
      expect(wrong.status, route).toBe(401)
    }
  })

  test.each([
    ['a Host that is not loopback', { host: 'evil.example' }, 403],
    ['a Host that only starts with localhost', { host: 'localhost.evil.example' }, 403],
    ['a browser Origin', { origin: 'http://127.0.0.1:3000' }, 403],
  ])('refuses requests with %s, even with the token', async (_, headers, status) => {
    daemon = await startDaemon({ home, version: '9.9.9' })
    const token = await tokenFor(home)

    for (const route of ['/healthz', '/tasks', '/events']) {
      const res = await rawRequest(daemon.port, {
        path: route,
        headers: { authorization: `Bearer ${token}`, ...headers },
      })
      expect(res.status, route).toBe(status)
    }
  })

  test('accepts localhost as the Host', async () => {
    daemon = await startDaemon({ home, version: '9.9.9' })

    const res = await rawRequest(daemon.port, {
      path: '/healthz',
      headers: { host: `localhost:${daemon.port}` },
    })

    expect(res.status).toBe(200)
  })

  test('creates and lists Tasks with the token, and keeps them across a restart', async () => {
    daemon = await startDaemon({ home, version: '9.9.9' })
    let token = await tokenFor(home)

    const created = await rawRequest(daemon.port, {
      method: 'POST',
      path: '/tasks',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Fix login' }),
    })
    expect(created.status).toBe(201)
    expect(JSON.parse(created.body)).toMatchObject({ displayId: 'DEV-1', title: 'Fix login' })

    await daemon.stop()
    daemon = await startDaemon({ home, version: '9.9.9' })
    token = await tokenFor(home)

    const listed = await rawRequest(daemon.port, {
      path: '/tasks',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(listed.status).toBe(200)
    expect(JSON.parse(listed.body)).toEqual([JSON.parse(created.body)])
  })

  test('shared parser errors keep their HTTP status behind the token guards', async () => {
    daemon = await startDaemon({ home, version: '9.9.9' })
    const token = await tokenFor(home)
    const port = daemon.port
    const body = JSON.stringify({ start: 'yes' })
    const post = (headers: Record<string, string>) =>
      rawRequest(port, {
        method: 'POST',
        path: '/tasks',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      })
    expect((await post({})).status).toBe(401)
    const invalid = await post({ authorization: `Bearer ${token}` })
    expect(invalid.status).toBe(400)
    expect(JSON.parse(invalid.body)).toEqual({ error: 'start must be true or false' })

    const message = JSON.stringify({ text: 'Hi', interrupt: 1 })
    const denied = await rawRequest(daemon.port, {
      method: 'POST',
      path: '/runs/r1/messages',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: message,
    })
    expect(denied.status).toBe(403)
    const signed = await rawRequest(daemon.port, {
      method: 'POST',
      path: '/runs/r1/messages',
      headers: {
        ...appHeaders(daemon.appToken, 'POST', '/runs/r1/messages', message),
        'content-type': 'application/json',
      },
      body: message,
    })
    expect(signed.status).toBe(400)
    expect(JSON.parse(signed.body)).toEqual({ error: 'interrupt must be true or false' })
  })

  test('refuses a Task without a title', async () => {
    daemon = await startDaemon({ home, version: '9.9.9' })
    const token = await tokenFor(home)

    const res = await rawRequest(daemon.port, {
      method: 'POST',
      path: '/tasks',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: '  ' }),
    })

    expect(res.status).toBe(400)
  })
})

describe('the token in daemon.json and the app’s token', () => {
  test.each([
    ['answer a request', 'POST', '/comments/c1/answer', { action: 'approve' }],
    ['talk a round through', 'POST', '/comments/c1/talk', {}],
    ['end a talk', 'POST', '/comments/c1/done-talking', {}],
    ['change settings', 'PATCH', '/settings', { developerMode: true }],
    ['start a Run outside a Task', 'POST', '/dev/runs', { prompt: 'x', cwd: '/' }],
    ['message a Run', 'POST', '/runs/r1/messages', { text: 'go ahead' }],
    ['save a Linear key', 'PUT', '/integrations/linear/key', { key: 'lin_api_x' }],
    ['archive a Task', 'POST', '/tasks/DEV-1/archive', {}],
    ['unarchive a Task', 'POST', '/tasks/DEV-1/unarchive', {}],
    ['delete a Task', 'POST', '/tasks/DEV-1/delete', {}],
    ['follow up a Task', 'POST', '/tasks/DEV-1/follow-up', { comment: 'Again' }],
    ['archive all in Done', 'POST', '/factories/DEV/archive-done', {}],
    ['install the ted command', 'POST', '/command-line/install', {}],
    ['stop the daemon and its Runs', 'POST', '/shutdown', {}],
    ['post a Comment as the user', 'POST', '/tasks/DEV-1/comments', { body: 'Approved' }],
    ['add a Factory', 'POST', '/dev/factories', { repo: '/tmp/evil/repo', key: 'EV' }],
    ['change a Factory’s local folder', 'PUT', '/factories/NB/local-folder', { path: '/' }],
  ])('daemon.json’s token can’t %s', async (_, method, route, body) => {
    daemon = await startDaemon({ home, version: '9.9.9' })

    const res = await rawRequest(daemon.port, {
      method,
      path: route,
      headers: { authorization: `Bearer ${await tokenFor(home)}` },
      body: JSON.stringify(body),
    })

    expect(res.status).toBe(403)
    expect(JSON.parse(res.body)).toEqual({ error: 'only the TED app can do this' })
  })

  test('the app’s token is never written to TED’s folder', async () => {
    daemon = await startDaemon({ home, version: '9.9.9' })
    const files = await readdir(home, { recursive: true, withFileTypes: true })

    for (const file of files.filter((f) => f.isFile())) {
      const text = await readFile(path.join(file.parentPath, file.name), 'latin1')
      expect(text.includes(daemon.appToken), file.name).toBe(false)
    }
  })

  test('daemon.json’s token may ask the daemon to hand over without stopping Runs', async () => {
    let shutdowns = 0
    daemon = await startDaemon({ home, version: '9.9.9', onShutdown: () => shutdowns++ })

    const res = await rawRequest(daemon.port, {
      method: 'POST',
      path: '/shutdown',
      headers: { authorization: `Bearer ${await tokenFor(home)}` },
      body: JSON.stringify({ keepRuns: true }),
    })

    expect(res.status).toBe(200)
    await expect.poll(() => shutdowns).toBe(1)
  })

  test('the app’s key signs each request and is never sent itself', async () => {
    daemon = await startDaemon({ home, version: '9.9.9' })
    const key = daemon.appToken
    const body = JSON.stringify({ maxWorkingRuns: 3 })
    const patch = (headers: Record<string, string>, text = body) =>
      rawRequest(daemon?.port ?? 0, { method: 'PATCH', path: '/settings', headers, body: text })

    expect((await patch({ authorization: `Bearer ${key}` })).status).toBe(401)
    const swapped = await patch(
      appHeaders(key, 'PATCH', '/settings', body),
      '{"developerMode":true}',
    )
    expect(swapped.status).toBe(400)
    const signed = appHeaders(key, 'PATCH', '/settings', body)
    expect((await patch(signed)).status).toBe(200)
    expect((await patch(signed)).status).toBe(401)
    expect((await patch(appHeaders(key, 'PATCH', '/tasks', body))).status).toBe(401)
    const wrongHash = {
      ...appHeaders(key, 'PATCH', '/settings', body),
      'x-ted-body-sha256': '0'.repeat(64),
    }
    expect((await patch(wrongHash)).status).toBe(401)
  })

  test('a signed GET may not carry a body, and a bad signature is refused before the body is read', async () => {
    daemon = await startDaemon({ home, version: '9.9.9' })

    const withBody = await rawRequest(daemon.port, {
      method: 'GET',
      path: '/settings',
      headers: appHeaders(daemon.appToken, 'GET', '/settings', 'x'),
      body: 'x',
    })
    expect(withBody.status).toBe(400)

    const forged = await rawRequest(daemon.port, {
      method: 'POST',
      path: '/attachments',
      headers: {
        ...appHeaders('0'.repeat(64), 'POST', '/attachments', 'x'.repeat(1024)),
        'x-ted-name': 'a.txt',
      },
      body: 'x'.repeat(1024),
    })
    expect(forged.status).toBe(401)
  })

  test('the daemon’s proof names its own port, so a relay on another port can’t pass it on', async () => {
    daemon = await startDaemon({ home, version: '9.9.9' })
    const real = daemon.port
    const relay = http.createServer((req, res) => {
      const out = http.request(
        { host: '127.0.0.1', port: real, method: req.method, path: req.url, headers: req.headers },
        (answer) => {
          res.writeHead(answer.statusCode ?? 500, answer.headers)
          answer.pipe(res)
        },
      )
      req.pipe(out)
    })
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
    try {
      const port = (relay.address() as AddressInfo).port
      const direct = { port: real, token: '', pid: process.pid, version: '9.9.9' }

      expect(await appClient(direct, daemon.appToken).provesAppKey()).toBe(true)
      expect(await appClient({ ...direct, port }, daemon.appToken).provesAppKey()).toBe(false)
    } finally {
      relay.close()
    }
  })
})
