import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import {
  type BrowserCommand,
  type BrowserReply,
  type DaemonClient,
  DaemonRequestError,
  type TaskApp,
} from '@ted/protocol'
import { afterEach, expect, test, vi } from 'vitest'

function makeSession() {
  return {
    setProxy: vi.fn(async () => {}),
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    removeAllListeners: vi.fn(),
    on: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn() },
    clearStorageData: vi.fn(async () => {}),
    closeAllConnections: vi.fn(async () => {}),
  }
}
function makeContents() {
  let destroyed = false
  return Object.assign(new EventEmitter(), {
    debugger: Object.assign(new EventEmitter(), {
      attach: vi.fn(),
      sendCommand: vi.fn(async (_method: string, _params?: unknown) => ({})),
    }),
    loadURL: vi.fn(async () => {}),
    isDestroyed: () => destroyed,
    close: vi.fn(() => {
      destroyed = true
    }),
    setWindowOpenHandler: vi.fn(),
    getURL: () => 'http://localhost:3000/',
    executeJavaScriptInIsolatedWorld: vi.fn(
      async (_world: number, scripts: { code: string }[]): Promise<unknown> => {
        const prefix = /const ref = "([^"]+)"/.exec(scripts[0]?.code ?? '')?.[1]
        return prefix ? `${prefix}:1 button Try it` : { x: 10, y: 10 }
      },
    ),
  })
}
const mocks = vi.hoisted(() => ({
  views: [] as { webContents: ReturnType<typeof makeContents> }[],
  sessions: [] as ReturnType<typeof makeSession>[],
}))
vi.mock('electron', () => ({
  session: {
    fromPartition: () => {
      const ses = makeSession()
      mocks.sessions.push(ses)
      return ses
    },
  },
  WebContentsView: class {
    webContents = makeContents()
    constructor() {
      mocks.views.push(this)
    }
    setBounds = vi.fn()
  },
}))

import { createTaskBrowsers } from '../src/browser.ts'

const app = {
  name: 'Web',
  repo: 'widgets',
  url: 'http://localhost:3000/',
  state: 'running',
  kind: 'web',
  startedAt: 'today',
} as TaskApp
const controllers: ReturnType<typeof createTaskBrowsers>[] = []
function bridge() {
  let deliver: ((command: BrowserCommand) => void) | undefined
  let rejectPoll: ((error: Error) => void) | undefined
  const replies: (BrowserReply & { id: string })[] = []
  const client = {
    browserApp: vi.fn(async () => app),
    getRun: vi.fn(async () => ({ run: { state: 'working' } })),
    pollBrowser: vi.fn(
      () =>
        new Promise<BrowserCommand>((resolve, reject) => {
          rejectPoll = reject
          deliver = resolve
        }),
    ),
    replyBrowser: vi.fn(async (_owner: string, id: string, reply: BrowserReply) => {
      replies.push({ id, ...reply })
    }),
  } as unknown as DaemonClient
  return {
    client,
    replies,
    failPoll: () => {
      deliver = undefined
      rejectPoll?.(new Error('Transport lost'))
    },
    async send(
      id: string,
      taskId: string,
      action: string,
      extra = {},
      lifetime = 1_000,
      runId?: string,
      shown: TaskApp = app,
    ) {
      await vi.waitFor(() => expect(deliver).toBeTypeOf('function'), { timeout: 3_000 })
      const next = deliver
      deliver = undefined
      next?.({
        id,
        taskId,
        ...(runId && { runId }),
        app: shown,
        expiresAt: Date.now() + lifetime,
        request: { action, ...extra },
      } as BrowserCommand)
      await vi.waitFor(() => expect(client.pollBrowser).toHaveBeenCalled())
    },
  }
}
afterEach(() => {
  for (const controller of controllers) controller.close()
  controllers.length = 0
  mocks.views.length = 0
  mocks.sessions.length = 0
})

test('a new client resumes polling while an idle Task retains its page and session', async () => {
  const first = bridge()
  let client = first.client
  const controller = createTaskBrowsers(
    () => undefined,
    () => client,
    vi.fn(),
  )
  controllers.push(controller)
  await first.send('open', 'one', 'open')
  await vi.waitFor(() => expect(first.replies).toHaveLength(1))
  const view = mocks.views[0]
  if (!view) throw new Error('Missing browser view')
  const second = bridge()
  controller.disconnected()
  client = second.client
  await first.send('obsolete', 'one', 'reload')
  await second.send('snapshot', 'one', 'snapshot')
  await vi.waitFor(() => expect(second.replies).toHaveLength(1))
  expect(second.replies[0]?.result?.text).toContain('Try it')
  expect(mocks.views).toHaveLength(1)
  expect(view.webContents.close).not.toHaveBeenCalled()
  expect(mocks.sessions[0]?.clearStorageData).not.toHaveBeenCalled()
  expect(first.replies).toHaveLength(1)
})

test('a delayed lookup cannot click after expiry and another Task keeps progressing', async () => {
  const transport = bridge()
  const controller = createTaskBrowsers(
    () => undefined,
    () => transport.client,
    vi.fn(),
  )
  controllers.push(controller)
  await transport.send('snapshot', 'one', 'snapshot')
  await vi.waitFor(() => expect(transport.replies).toHaveLength(1))
  const ref = (transport.replies[0]?.result?.text ?? '').split(' ')[0]
  const contents = mocks.views[0]?.webContents
  if (!contents) throw new Error('Missing browser contents')
  let release: ((point: { x: number; y: number }) => void) | undefined
  contents.executeJavaScriptInIsolatedWorld.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  await transport.send('click', 'one', 'click', { ref }, 150)
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  await transport.send('other', 'two', 'snapshot')
  await vi.waitFor(() =>
    expect(transport.replies.some((r) => r.id === 'other' && r.result)).toBe(true),
  )
  await vi.waitFor(() => expect(contents.close).toHaveBeenCalled())
  release?.({ x: 10, y: 10 })
  await vi.waitFor(() =>
    expect(transport.replies.some((r) => r.id === 'click' && r.error)).toBe(true),
  )
  expect(
    contents.debugger.sendCommand.mock.calls.some(([method]) => method.startsWith('Input.')),
  ).toBe(false)
  expect(mocks.sessions[0]?.clearStorageData).not.toHaveBeenCalled()
})

test('a navigation that never finishes is bounded without stopping other Tasks', async () => {
  const transport = bridge()
  const controller = createTaskBrowsers(
    () => undefined,
    () => transport.client,
    vi.fn(),
  )
  controllers.push(controller)
  await transport.send('open', 'one', 'open')
  await vi.waitFor(() => expect(transport.replies).toHaveLength(1))
  const contents = mocks.views[0]?.webContents
  if (!contents) throw new Error('Missing browser contents')
  contents.loadURL.mockImplementationOnce(() => new Promise(() => {}))
  await transport.send('navigate', 'one', 'navigate', { value: '/slow' }, 150)
  await transport.send('other', 'two', 'snapshot')
  await vi.waitFor(() =>
    expect(transport.replies.some((r) => r.id === 'other' && r.result)).toBe(true),
  )
  await vi.waitFor(() =>
    expect(transport.replies.some((r) => r.id === 'navigate' && r.error)).toBe(true),
  )
  expect(contents.close).toHaveBeenCalled()
})

test('an expired queued fill checks its deadline before touching the document', async () => {
  const transport = bridge()
  const controller = createTaskBrowsers(
    () => undefined,
    () => transport.client,
    vi.fn(),
  )
  controllers.push(controller)
  await transport.send('snapshot', 'one', 'snapshot')
  await vi.waitFor(() => expect(transport.replies).toHaveLength(1))
  const ref = (transport.replies[0]?.result?.text ?? '').split(' ')[0]
  const contents = mocks.views[0]?.webContents
  if (!contents) throw new Error('Missing browser contents')
  let queued = ''
  contents.executeJavaScriptInIsolatedWorld.mockImplementationOnce((_world, scripts) => {
    queued = scripts[0]?.code ?? ''
    return new Promise(() => {})
  })
  await transport.send('fill', 'one', 'fill', { ref, value: 'late' }, 100)
  await vi.waitFor(() => expect(queued).not.toBe(''))
  await vi.waitFor(() => expect(contents.close).toHaveBeenCalled())
  const lookup = vi.fn()
  expect(() => runInNewContext(queued, { Date, __tedElements: { get: lookup } })).toThrow(
    'Browser command expired',
  )
  expect(lookup).not.toHaveBeenCalled()
})

test('a transient polling error preserves an idle page and its session', async () => {
  const transport = bridge()
  const controller = createTaskBrowsers(
    () => undefined,
    () => transport.client,
    vi.fn(),
  )
  controllers.push(controller)
  await transport.send('open', 'one', 'open')
  await vi.waitFor(() => expect(transport.replies).toHaveLength(1))
  const view = mocks.views[0]
  if (!view) throw new Error('Missing browser view')
  transport.failPoll()
  await transport.send('snapshot', 'one', 'snapshot')
  await vi.waitFor(() => expect(transport.replies).toHaveLength(2))
  expect(view.webContents.close).not.toHaveBeenCalled()
  expect(mocks.sessions[0]?.clearStorageData).not.toHaveBeenCalled()
  expect(mocks.views).toHaveLength(1)
})

test('ending the requesting Run cancels a delayed click without replay', async () => {
  const transport = bridge()
  const controller = createTaskBrowsers(
    () => undefined,
    () => transport.client,
    vi.fn(),
  )
  controllers.push(controller)
  await transport.send('snapshot', 'one', 'snapshot')
  await vi.waitFor(() => expect(transport.replies).toHaveLength(1))
  const ref = (transport.replies[0]?.result?.text ?? '').split(' ')[0]
  const contents = mocks.views[0]?.webContents
  if (!contents) throw new Error('Missing browser contents')
  let release: ((value: unknown) => void) | undefined
  contents.executeJavaScriptInIsolatedWorld.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  await transport.send('click', 'one', 'click', { ref }, 5_000, 'run')
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  controller.ended('run')
  release?.({ x: 10, y: 10 })
  await vi.waitFor(() =>
    expect(transport.replies.some((r) => r.id === 'click' && r.error)).toBe(true),
  )
  expect(contents.close).toHaveBeenCalled()
  expect(
    contents.debugger.sendCommand.mock.calls.some(([method]) => method.startsWith('Input.')),
  ).toBe(false)
})

test.each(['App stop', 'App restart', 'Task deletion', 'Factory deletion'])(
  'retained sessions are cleared after cancellation then %s',
  async (lifecycle) => {
    const transport = bridge()
    const controller = createTaskBrowsers(
      () => undefined,
      () => transport.client,
      vi.fn(),
    )
    controllers.push(controller)
    await transport.send('open', 'one', 'open')
    await vi.waitFor(() => expect(transport.replies).toHaveLength(1))
    const contents = mocks.views[0]?.webContents
    if (!contents) throw new Error('Missing browser contents')
    contents.loadURL.mockImplementationOnce(() => new Promise(() => {}))
    await transport.send('navigate', 'one', 'navigate', { value: '/slow' }, 100)
    await vi.waitFor(() => expect(contents.close).toHaveBeenCalled())
    const validate = vi.mocked(transport.client.browserApp)
    if (lifecycle === 'App stop') validate.mockResolvedValue({ ...app, state: 'stopped' })
    else if (lifecycle === 'App restart')
      validate.mockResolvedValue({ ...app, startedAt: 'tomorrow' })
    else validate.mockRejectedValue(new DaemonRequestError(404, 'Task no longer exists'))
    controller.changed('one')
    await vi.waitFor(() => expect(mocks.sessions[0]?.clearStorageData).toHaveBeenCalledOnce())
    expect(mocks.sessions[0]?.closeAllConnections).toHaveBeenCalledOnce()
    validate.mockResolvedValue(app)
    await transport.send('reopen', 'one', 'open')
    await vi.waitFor(() =>
      expect(transport.replies.some((r) => r.id === 'reopen' && r.result)).toBe(true),
    )
    expect(mocks.sessions).toHaveLength(2)
  },
)

test('reopening a restarted App clears a canceled guest session before lifecycle validation returns', async () => {
  const transport = bridge()
  const controller = createTaskBrowsers(
    () => undefined,
    () => transport.client,
    vi.fn(),
  )
  controllers.push(controller)
  await transport.send('open', 'one', 'open')
  await vi.waitFor(() => expect(transport.replies).toHaveLength(1))
  const contents = mocks.views[0]?.webContents
  if (!contents) throw new Error('Missing browser contents')
  contents.loadURL.mockImplementationOnce(() => new Promise(() => {}))
  await transport.send('navigate', 'one', 'navigate', { value: '/slow' }, 100)
  await vi.waitFor(() => expect(contents.close).toHaveBeenCalled())
  const restarted = { ...app, startedAt: 'tomorrow' }
  vi.mocked(transport.client.browserApp).mockResolvedValue(restarted)
  await transport.send('reopen', 'one', 'open', {}, 1_000, undefined, restarted)
  await vi.waitFor(() =>
    expect(transport.replies.some((r) => r.id === 'reopen' && r.result)).toBe(true),
  )
  expect(mocks.sessions[0]?.clearStorageData).toHaveBeenCalledOnce()
  expect(mocks.sessions).toHaveLength(2)
})

test('guests reject system client certificates', async () => {
  const transport = bridge()
  const controller = createTaskBrowsers(
    () => undefined,
    () => transport.client,
    vi.fn(),
  )
  controllers.push(controller)
  await transport.send('open', 'one', 'open')
  await vi.waitFor(() => expect(transport.replies).toHaveLength(1))
  const contents = mocks.views[0]?.webContents
  if (!contents) throw new Error('Missing browser contents')
  const event = { preventDefault: vi.fn() }
  const select = vi.fn()
  contents.emit('select-client-certificate', event, 'https://localhost/', [{}], select)
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(select).toHaveBeenCalledWith()
})

test.each(['stop', 'restart'])(
  'a previously visited App’s %s clears the Task session while another App is selected',
  async (lifecycle) => {
    const transport = bridge()
    const other = { ...app, name: 'Other', url: 'http://localhost:4000/' }
    const current = new Map([
      [app.name, app],
      [other.name, other],
    ])
    vi.mocked(transport.client.browserApp).mockImplementation(async (_task, selected) => {
      const found = current.get(selected.name)
      if (!found) throw new DaemonRequestError(404, 'Missing App')
      return found
    })
    const controller = createTaskBrowsers(
      () => undefined,
      () => transport.client,
      vi.fn(),
    )
    controllers.push(controller)
    for (const [index, selected] of [app, other, app, other].entries()) {
      await transport.send(`open-${index}`, 'one', 'open', {}, 1_000, undefined, selected)
      await vi.waitFor(() => expect(transport.replies).toHaveLength(index + 1))
    }
    expect(mocks.sessions).toHaveLength(1)
    expect(mocks.sessions[0]?.clearStorageData).not.toHaveBeenCalled()
    current.set(
      app.name,
      lifecycle === 'stop' ? { ...app, state: 'stopped' } : { ...app, startedAt: 'tomorrow' },
    )
    controller.changed('one')
    await vi.waitFor(() => expect(mocks.sessions[0]?.clearStorageData).toHaveBeenCalledOnce())
    expect(mocks.sessions[0]?.closeAllConnections).toHaveBeenCalledOnce()
    const reopened = { ...app, startedAt: 'tomorrow' }
    current.set(app.name, reopened)
    await transport.send('reopen', 'one', 'open', {}, 1_000, undefined, reopened)
    await vi.waitFor(() => expect(transport.replies).toHaveLength(5))
    expect(mocks.sessions).toHaveLength(2)
  },
)

test('reopening an App after switching away detects its restart before lifecycle notification', async () => {
  const transport = bridge()
  const other = { ...app, name: 'Other', url: 'http://localhost:4000/' }
  vi.mocked(transport.client.browserApp).mockImplementation(async (_task, selected) =>
    selected.name === other.name ? other : app,
  )
  const controller = createTaskBrowsers(
    () => undefined,
    () => transport.client,
    vi.fn(),
  )
  controllers.push(controller)
  await transport.send('first', 'one', 'open')
  await vi.waitFor(() => expect(transport.replies).toHaveLength(1))
  await transport.send('other', 'one', 'open', {}, 1_000, undefined, other)
  await vi.waitFor(() => expect(transport.replies).toHaveLength(2))
  const restarted = { ...app, startedAt: 'tomorrow' }
  vi.mocked(transport.client.browserApp).mockResolvedValue(restarted)
  await transport.send('reopen', 'one', 'open', {}, 1_000, undefined, restarted)
  await vi.waitFor(() => expect(transport.replies).toHaveLength(3))
  expect(mocks.sessions[0]?.clearStorageData).toHaveBeenCalledOnce()
  expect(mocks.sessions[0]?.closeAllConnections).toHaveBeenCalledOnce()
  expect(mocks.sessions).toHaveLength(2)
})

test('switching Apps does not discard a pending lifecycle check for the retained session', async () => {
  const transport = bridge()
  const other = { ...app, name: 'Other', url: 'http://localhost:4000/' }
  const controller = createTaskBrowsers(
    () => undefined,
    () => transport.client,
    vi.fn(),
  )
  controllers.push(controller)
  await transport.send('first', 'one', 'open')
  await vi.waitFor(() => expect(transport.replies).toHaveLength(1))
  let rejectValidation: ((error: Error) => void) | undefined
  vi.mocked(transport.client.browserApp).mockImplementation(async (_task, selected) => {
    if (selected.name === other.name) return other
    return new Promise((_resolve, reject) => {
      rejectValidation = reject
    })
  })
  controller.changed('one')
  await vi.waitFor(() => expect(rejectValidation).toBeTypeOf('function'))
  await transport.send('other', 'one', 'open', {}, 1_000, undefined, other)
  await vi.waitFor(() => expect(transport.replies).toHaveLength(2))
  rejectValidation?.(new DaemonRequestError(404, 'App no longer exists'))
  await vi.waitFor(() => expect(mocks.sessions[0]?.clearStorageData).toHaveBeenCalledOnce())
  expect(mocks.sessions[0]?.closeAllConnections).toHaveBeenCalledOnce()
})
