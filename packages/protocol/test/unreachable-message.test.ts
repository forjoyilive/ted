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
    'TED in the background isn’t running. Try again in a moment; TED starts it again on its own.',
  )

  const resets = await listen((socket) => socket.resetAndDestroy())
  expect(await failure(client(resets).listTasks())).toBe(
    'TED in the background stopped before it answered. Try again in a moment; TED starts it again on its own.',
  )

  const silent = await listen((socket) => socket.resume())
  expect(await failure(client(silent, 1000).listTasks())).toBe(
    'TED in the background hasn’t answered for 1 second. It may be busy or stuck; if this keeps happening, quit TED and open it again.',
  )
})
