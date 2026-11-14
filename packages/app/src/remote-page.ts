import { randomUUID } from 'node:crypto'
import http from 'node:http'
import type { DrivenPage, PageDriver } from './browser-page.ts'

export interface RemotePage extends DrivenPage {
  port: number
  close(): void
}

interface Target {
  id?: unknown
  type?: unknown
  url?: unknown
}

interface Message {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { message?: string }
}

const listMs = 5_000

export function pageTarget(targets: unknown): string | undefined {
  if (!Array.isArray(targets)) return undefined
  const page = (targets as Target[]).find(
    (t) =>
      t.type === 'page' &&
      typeof t.id === 'string' &&
      /^[A-F0-9]{32}$/i.test(t.id) &&
      typeof t.url === 'string' &&
      !t.url.startsWith('devtools:'),
  )
  return page?.id as string | undefined
}

function listTargets(port: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: '127.0.0.1', port, path: '/json/list', timeout: listMs },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          body += chunk
          if (body.length > 1_000_000) request.destroy(new Error('target list too large'))
        })
        response.on('end', () => {
          try {
            resolve(JSON.parse(body))
          } catch {
            reject(new Error('The App’s debugging port didn’t answer with its windows'))
          }
        })
      },
    )
    request.once('timeout', () => request.destroy(new Error('timed out')))
    request.once('error', reject)
  })
}

function errorText(details: Record<string, unknown>): string {
  const exception = details.exception as { description?: unknown } | undefined
  const text =
    typeof exception?.description === 'string'
      ? exception.description
      : typeof details.text === 'string'
        ? details.text
        : 'Script failed'
  return (text.split('\n')[0] ?? text).replace(/^Error: /, '')
}

export async function openRemote(
  port: number,
  options: { check(): void; gone(page: RemotePage): void },
): Promise<RemotePage> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Bad debugging port')
  const id = pageTarget(await listTargets(port))
  options.check()
  if (!id) throw new Error('The App has no window yet; try again when it has started')
  const socket = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${id}`)
  const pending = new Map<number, { resolve(m: Message): void; reject(e: Error): void }>()
  let next = 0
  let closed = false
  let world: number | undefined
  let address = ''
  let mainFrame: string | undefined
  let page: RemotePage | undefined
  let revision = randomUUID()
  const fail = () => {
    if (closed) return
    closed = true
    for (const waiter of pending.values()) waiter.reject(new Error('The App’s window closed'))
    pending.clear()
    if (page) options.gone(page)
  }
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      if (closed) return reject(new Error('The App’s window closed'))
      const messageId = ++next
      pending.set(messageId, {
        resolve: (m) =>
          m.error ? reject(new Error(m.error.message ?? 'CDP error')) : resolve(m.result ?? {}),
        reject,
      })
      socket.send(JSON.stringify({ id: messageId, method, params }))
    })
  socket.addEventListener('message', (event) => {
    let message: Message
    try {
      message = JSON.parse(String(event.data)) as Message
    } catch {
      return
    }
    if (message.id !== undefined) {
      pending.get(message.id)?.resolve(message)
      pending.delete(message.id)
      return
    }
    const params = message.params ?? {}
    if (message.method === 'Page.javascriptDialogOpening') {
      void send('Page.handleJavaScriptDialog', { accept: false }).catch(() => undefined)
    } else if (message.method === 'Page.frameNavigated') {
      const frame = params.frame as { id?: unknown; parentId?: unknown; url?: unknown } | undefined
      if (frame && frame.parentId === undefined) {
        if (typeof frame.id === 'string') mainFrame = frame.id
        revision = randomUUID()
        if (page) page.revision = revision
        world = undefined
        if (typeof frame.url === 'string') address = frame.url
      }
    } else if (
      message.method === 'Page.navigatedWithinDocument' &&
      mainFrame !== undefined &&
      params.frameId === mainFrame
    ) {
      revision = randomUUID()
      if (page) page.revision = revision
      if (typeof params.url === 'string') address = params.url
    } else if (
      message.method === 'Runtime.executionContextsCleared' ||
      (message.method === 'Runtime.executionContextDestroyed' &&
        params.executionContextId === world)
    ) {
      world = undefined
    } else if (
      message.method === 'Inspector.detached' ||
      message.method === 'Inspector.targetCrashed'
    ) {
      socket.close()
    }
  })
  socket.addEventListener('close', fail)
  socket.addEventListener('error', fail)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('close', () => reject(new Error('The App’s debugging port closed')), {
      once: true,
    })
  })

  const frameId = async () => {
    const { frameTree } = (await send('Page.getFrameTree')) as {
      frameTree?: { frame?: { id?: unknown; url?: unknown } }
    }
    const frame = frameTree?.frame
    if (typeof frame?.id !== 'string') throw new Error('The App’s window has no page')
    if (typeof frame.url === 'string') address = frame.url
    mainFrame = frame.id
    return frame.id
  }
  const isolated = async () => {
    if (world !== undefined) return world
    const { executionContextId } = await send('Page.createIsolatedWorld', {
      frameId: await frameId(),
      worldName: 'ted',
    })
    if (typeof executionContextId !== 'number') throw new Error('The App’s page isn’t ready')
    world = executionContextId
    return world
  }
  const historyStep = async (step: -1 | 1) => {
    const { currentIndex, entries } = (await send('Page.getNavigationHistory')) as {
      currentIndex?: number
      entries?: { id?: number }[]
    }
    const entry = entries?.[(currentIndex ?? 0) + step]
    if (typeof entry?.id === 'number')
      await send('Page.navigateToHistoryEntry', { entryId: entry.id })
  }
  const driver: PageDriver = {
    url: () => address,
    gone: () => closed,
    async script(code) {
      const { result, exceptionDetails } = (await send('Runtime.evaluate', {
        expression: code,
        contextId: await isolated(),
        awaitPromise: true,
        returnByValue: true,
      })) as { result?: { value?: unknown }; exceptionDetails?: Record<string, unknown> }
      if (exceptionDetails) throw new Error(errorText(exceptionDetails))
      return result?.value
    },
    send,
    async load() {
      throw new Error('A desktop App has no addresses to navigate to')
    },
    back: () => historyStep(-1),
    forward: () => historyStep(1),
    async reload() {
      await send('Page.reload')
    },
    async capture() {
      const { data } = await send('Page.captureScreenshot', { format: 'png' })
      if (typeof data !== 'string') throw new Error('The screenshot failed')
      return new Uint8Array(Buffer.from(data, 'base64'))
    },
  }
  const opened: RemotePage = {
    port,
    driver,
    revision,
    navigate: false,
    resize: async (width, height) => {
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      })
    },
    close: () => {
      closed = true
      socket.close()
    },
  }
  page = opened
  try {
    await send('Page.enable')
    await send('Runtime.enable')
    await frameId()
    options.check()
  } catch (error) {
    opened.close()
    throw error
  }
  return opened
}
