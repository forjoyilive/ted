import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { createServer, type Server, type Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { DaemonClient, DaemonUnreachableError } from '@ted/protocol'
import { afterEach, expect, test } from 'vitest'

const electronPath = createRequire(import.meta.url)('electron') as string
const serverPath = fileURLToPath(new URL('./fixtures/reset-server.ts', import.meta.url))
const clientPath = fileURLToPath(new URL('./fixtures/reset-client.ts', import.meta.url))
const run = promisify(execFile)
const electronNode = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }

let server: ChildProcess | undefined
let silent: Server | undefined
const sockets = new Set<Socket>()

afterEach(async () => {
  if (server && server.exitCode === null) {
    server.kill('SIGKILL')
    await once(server, 'exit')
  }
  server = undefined
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  silent?.close()
  silent = undefined
})

test('a daemon that resets connections only rejects requests, in Electron’s Node', async () => {
  server = spawn(electronPath, [serverPath], {
    env: electronNode,
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const [line] = (await once(server.stdout as NodeJS.ReadableStream, 'data')) as [Buffer]
  const port = String(line).trim()

  const { stdout } = await run(electronPath, [clientPath, port, '100'], {
    env: electronNode,
    timeout: 60_000,
  })
  expect(JSON.parse(stdout)).toEqual({ uncaught: [], failures: { unreachable: 100 } })
}, 90_000)

test('a daemon that accepts a request and never answers fails it after the idle timeout', async () => {
  silent = createServer((socket) => {
    sockets.add(socket)
    socket.resume()
  })
  silent.listen(0, '127.0.0.1')
  await once(silent, 'listening')
  const address = silent.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const client = new DaemonClient({ port, token: 't', pid: 0, version: '0' }, 't', {
    idleTimeoutMs: 300,
  })

  await expect(client.listTasks()).rejects.toBeInstanceOf(DaemonUnreachableError)
  await expect(client.subscribe(() => undefined)).rejects.toBeInstanceOf(DaemonUnreachableError)
})
