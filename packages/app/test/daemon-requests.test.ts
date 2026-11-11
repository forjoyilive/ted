import { once } from 'node:events'
import { createServer } from 'node:http'
import { DaemonClient, DaemonRequestError, defaultMachineSettings } from '@ted/protocol'
import { expect, test, vi } from 'vitest'
import { getAutomation, taskBrief } from '../src/daemon-adapters.ts'
import {
  daemonRequests,
  forwardDaemonRequest,
  forwardedRequests,
  isForwardedRequest,
} from '../src/daemon-requests.ts'

const client = () => new DaemonClient({ port: 1, token: 'test', pid: 0, version: '0' })

test('every explicitly exposed name is a unique DaemonClient method', () => {
  const instance = client()
  expect(new Set(forwardedRequests).size).toBe(forwardedRequests.length)
  for (const name of forwardedRequests) expect(typeof instance[name], name).toBe('function')
})

test.each([
  'constructor',
  '__proto__',
  'toString',
  'subscribe',
  'provesAppKey',
  'shutdown',
  'getReport',
  'exportFactory',
  'getAutomation',
  'taskBrief',
  '',
  null,
  {},
  ['listTasks'],
])('rejects an unlisted or non-string request %j before reading the client', (name) => {
  const instance = new Proxy(client(), {
    get() {
      throw new Error('client was accessed')
    },
  })
  expect(isForwardedRequest(name)).toBe(false)
  expect(() => forwardDaemonRequest(instance, name, [])).toThrow('unknown daemon request')
})

test('renderer forwards exact client arguments and results through its supplied transport', async () => {
  const result = { id: 'comment' }
  const request = vi.fn(async (_name: string, ..._args: unknown[]) => result)
  const api = daemonRequests(request)
  const input = {
    body: 'Hello',
    attachments: [{ hash: 'hash', name: 'file.txt', mediaType: 'text/plain' }],
  }
  expect(await api.postComment('NB-1', input)).toBe(result)
  expect(request).toHaveBeenCalledExactlyOnceWith('postComment', 'NB-1', input)
  expect(request.mock.calls[0]?.[2]).toBe(input)
  expect(Object.keys(api)).toEqual(forwardedRequests)
})

test('dispatch binds the real client, preserves objects and encoded identifiers, and propagates daemon errors', async () => {
  const received: { method: string | undefined; url: string | undefined; body: unknown }[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const text = Buffer.concat(chunks).toString()
    received.push({ method: req.method, url: req.url, body: text ? JSON.parse(text) : undefined })
    res.setHeader('content-type', 'application/json')
    if (req.url?.endsWith('/brief')) {
      res.writeHead(404).end(JSON.stringify({ error: 'no brief' }))
    } else res.end(JSON.stringify({ id: 'comment' }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing port')
    const instance = new DaemonClient({ port: address.port, token: 'test', pid: 0, version: '0' })
    const input = { body: 'Hello', attachments: [] }
    const api = daemonRequests((name, ...args) => forwardDaemonRequest(instance, name, args))
    expect(await api.postComment('task/with space', input)).toEqual({ id: 'comment' })
    expect(received[0]).toEqual({
      method: 'POST',
      url: '/tasks/task%2Fwith%20space/comments',
      body: input,
    })
    expect(await taskBrief(instance, 'NB-1')).toBeNull()
    await expect(instance.getBrief('NB-1')).rejects.toBeInstanceOf(DaemonRequestError)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

test('Linear intake calls retain their client arguments through the request bridge', async () => {
  const instance = client()
  const choices = {
    teams: [],
    projects: [],
    workspaceId: 'w1',
    workspace: 'workspace',
  }
  const read = vi.spyOn(instance, 'getLinearIntakeChoices').mockResolvedValue(choices)
  const save = vi
    .spyOn(instance, 'setFactoryLinearIntake')
    .mockResolvedValue(defaultMachineSettings)
  const api = daemonRequests((name, ...args) => forwardDaemonRequest(instance, name, args))
  expect(await api.getLinearIntakeChoices()).toBe(choices)
  expect(read).toHaveBeenCalledExactlyOnceWith()
  const scope = {
    kind: 'team' as const,
    id: 'team-one',
    name: 'Team One',
    workspaceId: 'w1',
    workspace: 'workspace',
  }
  await api.setFactoryLinearIntake('factory/one', scope)
  expect(save).toHaveBeenCalledExactlyOnceWith('factory/one', scope)
  expect(save.mock.calls[0]?.[1]).toBe(scope)
  await api.setFactoryLinearIntake('factory/one', null)
  expect(save).toHaveBeenLastCalledWith('factory/one', null)
})

test('transport failures are not swallowed by forwards or the missing-brief adapter', async () => {
  const failure = new Error('connection lost')
  const api = daemonRequests(async () => {
    throw failure
  })
  await expect(api.listTasks()).rejects.toBe(failure)
  const instance = client()
  const getBrief = vi
    .spyOn(instance, 'getBrief')
    .mockRejectedValue(new DaemonRequestError(503, 'not ready'))
  await expect(taskBrief(instance, 'NB-1')).rejects.toMatchObject({ status: 503 })
  getBrief.mockRejectedValue(failure)
  await expect(taskBrief(instance, 'NB-1')).rejects.toBe(failure)
})

test('missing Automation adapters preserve null and propagate other failures', async () => {
  const instance = client()
  const read = vi
    .spyOn(instance, 'getAutomation')
    .mockRejectedValue(new DaemonRequestError(404, 'missing'))
  expect(await getAutomation(instance, 'a1')).toBeNull()
  read.mockRejectedValue(new DaemonRequestError(503, 'not ready'))
  await expect(getAutomation(instance, 'a1')).rejects.toMatchObject({ status: 503 })
})

test('invalid upload bytes are rejected before calling the client upload', () => {
  const instance = client()
  const upload = vi.spyOn(instance, 'uploadAttachment')
  expect(() =>
    forwardDaemonRequest(instance, 'uploadAttachment', [
      { name: 'x', mediaType: 'text/plain' },
      [1, 2],
    ]),
  ).toThrow('Uint8Array')
  expect(upload).not.toHaveBeenCalled()
})

function typeAssertions(api: ReturnType<typeof daemonRequests>) {
  // @ts-expect-error Unlisted DaemonClient methods are unavailable to the renderer.
  api.provesAppKey()
  // @ts-expect-error Forwarded methods use the client request shape.
  api.setClarifyDepth('NB-1', 'few')
  // @ts-expect-error Forwarded names cannot be misspelled.
  const wrong: (typeof forwardedRequests)[number] = 'listTaskz'
  return wrong
}
void typeAssertions
