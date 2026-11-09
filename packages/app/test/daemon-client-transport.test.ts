import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, test } from 'vitest'

const electronPath = createRequire(import.meta.url)('electron') as string
const serverPath = fileURLToPath(new URL('./fixtures/reset-server.ts', import.meta.url))
const clientPath = fileURLToPath(new URL('./fixtures/reset-client.ts', import.meta.url))
const run = promisify(execFile)
const electronNode = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }

let server: ChildProcess | undefined

afterEach(async () => {
  if (server && server.exitCode === null) {
    server.kill('SIGKILL')
    await once(server, 'exit')
  }
  server = undefined
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
