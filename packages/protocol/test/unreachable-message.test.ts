import { once } from 'node:events'
import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, expect, test } from 'vitest'
import { DaemonClient, DaemonUnreachableError } from '../src/index.ts'

const servers: Server[] = []
const sockets = new Set<Socket>()

afterEach(() => {
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  for (const server of servers.splice(0)) server.close()
})

async function listen(onSocket: (socket: Socket) => void): Promise<number> {
  const server = createServer((socket) => {
    sockets.add(socket)
    onSocket(socket)
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  return typeof address === 'object' && address ? address.port : 0
}

const client = (port: number, idleTimeoutMs?: number) =>
  new DaemonClient({ port, token: 't', pid: 0, version: '0' }, 't', {
    ...(idleTimeoutMs !== undefined && { idleTimeoutMs }),
  })

async function failure(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(DaemonUnreachableError)
  return (error as Error).message
}

test('an unreachable daemon says why, in the app’s words, without the port', async () => {
  const closed = await listen(() => undefined)
  servers.pop()?.close()
  expect(await failure(client(closed).listTasks())).toBe(
    'Ted in the background isn’t running. Try again in a moment.',
  )

  const resets = await listen((socket) => socket.resetAndDestroy())
  expect(await failure(client(resets).listTasks())).toBe(
    'Ted in the background closed the connection before it answered. Try again in a moment.',
  )

  const stalls = await listen((socket) => {
    socket.resume()
    socket.write('HTTP/1.1 200 OK\r\ncontent-length: 10\r\n\r\n[')
  })
  expect(await failure(client(stalls, 1000).listTasks())).toContain('hasn’t answered for 1 second')

  const silent = await listen((socket) => socket.resume())
  expect(await failure(client(silent, 1000).listTasks())).toBe(
    'Ted in the background hasn’t answered for 1 second. It may be busy or stuck; if this keeps happening, quit Ted and open it again.',
  )
})

test('the New Task draft loads after one connection reset', async () => {
  let attempts = 0
  const port = await listen((socket) => {
    socket.once('data', () => {
      attempts++
      if (attempts === 1) {
        socket.resetAndDestroy()
        return
      }
      const body = JSON.stringify({ draft: null, clearedRevision: 'consumed' })
      socket.end(
        `HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      )
    })
  })
  expect(await client(port).taskDraft('factory')).toEqual({
    draft: null,
    clearedRevision: 'consumed',
  })
  expect(attempts).toBe(2)
})

test('the New Task draft reports a second connection reset', async () => {
  let attempts = 0
  const port = await listen((socket) => {
    socket.once('data', () => {
      attempts++
      socket.resetAndDestroy()
    })
  })
  expect(await failure(client(port).taskDraft('factory'))).toContain(
    'closed the connection before it answered',
  )
  expect(attempts).toBe(2)
})
