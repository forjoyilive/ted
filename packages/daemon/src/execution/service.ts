import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import http from 'node:http'
import { homedir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  identity,
  parseWorkerPairRequest,
  tedEnv,
  type WorkerPairRequest,
  type WorkerStatus,
} from '@ted/protocol'
import { createEnvironment, executionEnvironment } from '../command-env.ts'
import { inheritedFdsEnv } from '../inherited-fds.ts'
import { tryLock } from '../lock.ts'
import { nodeEntry } from '../node-entry.ts'
import { readJson } from '../routes/route.ts'
import { privateDirectory, readPrivate, writePrivate } from './files.ts'
import { createExecutionWorker } from './worker.ts'

export function executionHome(env: NodeJS.ProcessEnv = process.env): string {
  return (
    tedEnv('TED_EXECUTION_HOME', env) ??
    `${tedEnv('TED_HOME', env) ?? path.join(homedir(), identity().homeFolder)}-execution`
  )
}
interface Control {
  pid: number
  port: number
  token: string
  owner?: string
}
async function control(home: string): Promise<Control> {
  await privateDirectory(home)
  const v = JSON.parse(await readPrivate(home, 'control.json')) as Control
  if (
    !Number.isInteger(v.pid) ||
    v.pid <= 1 ||
    !Number.isInteger(v.port) ||
    v.port < 1 ||
    v.port > 65535 ||
    !/^[a-f0-9]{64}$/.test(v.token) ||
    (v.owner !== undefined && !/^[a-f0-9]{64}$/.test(v.owner))
  )
    throw new Error('Invalid worker control record')
  return v
}
export async function workerRequest(
  home: string,
  operation: 'status' | 'start' | 'stop' | 'pair' | 'shutdown',
  input?: WorkerPairRequest,
): Promise<WorkerStatus> {
  const info = await control(home)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: info.port,
        method: 'POST',
        path: `/${operation}`,
        headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
      },
      (res) => {
        let data = ''
        res.on('data', (chunk: Buffer) => {
          if (data.length + chunk.length > 32 * 1024)
            res.destroy(new Error('Worker status too large'))
          else data += chunk.toString('utf8')
        })
        res.on('error', reject)
        res.on('end', () => {
          try {
            const value = JSON.parse(data) as WorkerStatus & { error?: string }
            if (res.statusCode !== 200) reject(new Error(value.error ?? 'Worker request refused'))
            else resolve(value)
          } catch (error) {
            reject(error)
          }
        })
      },
    )
    req.setTimeout(30_000, () => req.destroy(new Error('Worker is not responding')))
    req.on('error', reject)
    req.end(JSON.stringify(input ?? {}))
  })
}
export async function startExecutionService(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  owner?: string,
): Promise<{ started: boolean; status: WorkerStatus; owner: string | undefined }> {
  try {
    const status = await workerRequest(home, 'status')
    return { started: false, status, owner: (await control(home)).owner }
  } catch (error) {
    if (
      !['ENOENT', 'ECONNREFUSED', 'ECONNRESET'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    )
      throw error
  }
  await privateDirectory(home)
  const log = await open(
    path.join(home, 'service.log'),
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  )
  const logInfo = await log.stat()
  if (!logInfo.isFile() || (logInfo.mode & 0o077) !== 0) {
    await log.close()
    throw new Error('Worker log must be a private regular file')
  }
  const childEnv = {
    ...executionEnvironment(env),
    ...inheritedFdsEnv(),
    TED_EXECUTION_HOME: home,
    ELECTRON_RUN_AS_NODE: '1',
  }
  const entry = nodeEntry(
    path.join(import.meta.dirname, './main.ts'),
    owner ? ['--owner', owner] : [],
    childEnv,
  )
  const child = spawn(entry.command, entry.args, {
    env: childEnv,
    detached: true,
    stdio: ['ignore', log.fd, log.fd],
  })
  await log.close()
  let failed: Error | undefined
  child.on('error', (error) => {
    failed = error
  })
  child.unref()
  const until = Date.now() + 45_000
  while (Date.now() < until) {
    if (failed) throw failed
    try {
      const status = await workerRequest(home, 'status')
      const info = await control(home)
      return { started: info.pid === child.pid, status, owner: info.owner }
    } catch (error) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error('Execution service could not start. Inspect its isolated service.log.')
      if (
        !['ENOENT', 'ECONNREFUSED', 'ECONNRESET'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error
    }
    await delay(100)
  }
  throw new Error('Execution service did not start before the deadline')
}
export async function serveExecution(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  owner?: string,
) {
  if (owner !== undefined && !/^[a-f0-9]{64}$/.test(owner))
    throw new Error('Invalid worker owner label')
  await privateDirectory(home)
  const lockPath = path.join(home, 'service-lock.db')
  const previous = await lstat(lockPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (previous && (!previous.isFile() || previous.isSymbolicLink()))
    throw new Error('Worker lock must be a regular file')
  const lock = tryLock(lockPath)
  if (!lock) throw new Error('An execution service already owns this home')
  let worker: Awaited<ReturnType<typeof createExecutionWorker>>
  try {
    const environment = createEnvironment({
      base: executionEnvironment(env),
      loginShell: tedEnv('TED_LOGIN_SHELL', env) !== 'off',
    })
    worker = await createExecutionWorker(home, executionEnvironment(await environment.reload()))
  } catch (error) {
    lock.release()
    throw error
  }
  const token = randomBytes(32).toString('hex')
  let closing = false
  let mutations = Promise.resolve()
  function mutate(work: () => Promise<void>) {
    const next = mutations.then(work)
    mutations = next.catch(() => undefined)
    return next
  }
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.socket.remoteAddress !== '127.0.0.1' || req.method !== 'POST')
        throw new Error('Local worker requests only')
      const given = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
      if (given.length !== token.length || !timingSafeEqual(Buffer.from(given), Buffer.from(token)))
        throw new Error('Worker control authorization required')
      if (closing) throw new Error('Worker is stopping')
      const pair = req.url === '/pair' ? parseWorkerPairRequest(await readJson(req)) : undefined
      if (req.url !== '/status')
        await mutate(async () => {
          if (closing) throw new Error('Worker is stopping')
          if (req.url === '/start') await worker.start()
          else if (req.url === '/stop') await worker.stop()
          else if (req.url === '/pair' && pair) await worker.pair(pair)
          else if (req.url === '/shutdown') closing = true
          else throw new Error('Unknown worker operation')
        })
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(worker.status()))
      if (req.url === '/shutdown') void close()
    })().catch(() => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error:
            'Worker request refused. Check the operation, pairing details and current connection state.',
        }),
      )
    })
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  server.maxConnections = 8
  const ended = Promise.withResolvers<void>()
  const heldLock = lock
  let closePromise: Promise<void> | undefined
  function close(): Promise<void> {
    closePromise ??= (async () => {
      closing = true
      await worker.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      heldLock.release()
      ended.resolve()
    })()
    return closePromise
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Worker control did not bind')
    await writePrivate(
      home,
      'control.json',
      JSON.stringify({ pid: process.pid, port: address.port, token, ...(owner && { owner }) }),
    )
  } catch (error) {
    await close()
    throw error
  }
  return { worker, close, closed: ended.promise }
}

export async function stopExecutionService(home: string): Promise<void> {
  const info = await control(home)
  await workerRequest(home, 'shutdown').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ECONNREFUSED') throw error
  })
  const until = Date.now() + 15_000
  while (Date.now() < until) {
    try {
      process.kill(info.pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    await delay(50)
  }
  throw new Error('Worker shutdown was requested but process exit is unresolved')
}

export async function executionServiceOwner(home: string): Promise<string | undefined> {
  const exists = await lstat(home).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (!exists) return undefined
  try {
    return (await control(home)).owner
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
