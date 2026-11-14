import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { type AppRef, type BrowserRequest, edition, type TaskApp, tedEnv } from '@ted/protocol'
import { RequestError } from '../errors.ts'
import { workCommand } from '../priority.ts'
import { redactSecrets } from '../redact.ts'
import { removeInside } from '../tasks/remove-files.ts'

export interface RunBrowserResult {
  url?: string
  text?: string
  capture?: Buffer
}

interface Reply {
  id: string
  url?: string
  text?: string
  capture?: string
  error?: string
}

interface Helper {
  child: ChildProcess
  ready: Promise<void>
  replies: Map<string, (reply: Reply) => void>
  app?: TaskApp
  busy: boolean
}

export interface RunBrowsers {
  command(runId: string, app: TaskApp, request: BrowserRequest): Promise<RunBrowserResult>
  opened(runId: string): AppRef | undefined
  close(runId: string, app?: AppRef): void
  closeAll(): void
}

const appDir = fileURLToPath(new URL('../../../app/', import.meta.url))
const commandMs = 20_000
const startMs = 30_000
const flag = '--ted-headless-browser'

export function helperCommand(env: NodeJS.ProcessEnv = process.env): {
  command: string
  args: string[]
} {
  const flags = [flag, ...(process.platform === 'linux' ? ['--ozone-platform=headless'] : [])]
  if (env.APPIMAGE) return { command: env.APPIMAGE, args: flags }
  if (process.versions.electron)
    return { command: process.execPath, args: edition === 'release' ? flags : [appDir, ...flags] }
  const command =
    tedEnv('TED_ELECTRON_BIN', env) ??
    (createRequire(path.join(appDir, 'package.json'))('electron') as string)
  return { command, args: [appDir, ...flags] }
}

const sameApp = (a: TaskApp, b: TaskApp) =>
  a.repo === b.repo && a.name === b.name && a.url === b.url && a.startedAt === b.startedAt

export function createRunBrowsers(options: {
  dir: string
  env: () => NodeJS.ProcessEnv
  lowPriority: () => boolean
}): RunBrowsers {
  const helpers = new Map<string, Helper>()
  const starting = new Set<string>()
  const swept = removeInside(path.dirname(options.dir), path.basename(options.dir)).catch(
    () => undefined,
  )

  const stop = (runId: string) => {
    const helper = helpers.get(runId)
    if (!helper) return
    helpers.delete(runId)
    for (const resolve of helper.replies.values())
      resolve({ id: '', error: 'The Run’s browser closed' })
    helper.replies.clear()
    helper.child.stdin?.end()
    try {
      if (helper.child.pid !== undefined) process.kill(-helper.child.pid, 'SIGKILL')
    } catch {
      helper.child.kill('SIGKILL')
    }
    void removeInside(options.dir, runId).catch(() => undefined)
  }

  const start = async (runId: string): Promise<Helper> => {
    await swept
    await mkdir(options.dir, { recursive: true, mode: 0o700 })
    const profile = path.join(options.dir, runId)
    await mkdir(profile, { recursive: true, mode: 0o700 })
    const helper = helperCommand(options.env())
    const { command, args } = workCommand(helper.command, helper.args, options.lowPriority())
    const { ELECTRON_RUN_AS_NODE: _, ...env } = options.env()
    const child = spawn(command, args, {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...env, TED_BROWSER_PROFILE: profile },
    })
    const replies = new Map<string, (reply: Reply) => void>()
    let markReady: () => void = () => undefined
    let failed: (error: Error) => void = () => undefined
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve
      failed = reject
    })
    const timer = setTimeout(() => failed(new Error('timed out')), startMs)
    child.stdin?.on('error', () => undefined)
    child.on('error', (error) => failed(error))
    let errors = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      errors = (errors + chunk.toString()).slice(-2000)
    })
    child.on('exit', () => {
      failed(new Error(`exited: ${errors.trim().split('\n').slice(-3).join(' ')}`))
      if (helpers.get(runId)?.child === child) stop(runId)
    })
    if (child.stdout)
      createInterface({ input: child.stdout }).on('line', (line) => {
        let reply: Reply
        try {
          reply = JSON.parse(line) as Reply
        } catch {
          return
        }
        if (reply.id === 'ready') markReady()
        replies.get(reply.id)?.(reply)
      })
    const started: Helper = { child, ready, replies, busy: true }
    helpers.set(runId, started)
    try {
      await ready
    } catch (error) {
      console.error(
        redactSecrets(`couldn’t start the browser of Run ${runId}: ${(error as Error).message}`),
      )
      stop(runId)
      throw new RequestError(503, 'The Run’s browser couldn’t start')
    } finally {
      clearTimeout(timer)
    }
    if (helpers.get(runId) !== started) throw new RequestError(409, 'The Run’s browser closed')
    return started
  }

  const send = (helper: Helper, app: TaskApp, request: BrowserRequest) => {
    const id = randomUUID()
    return new Promise<Reply>((resolve) => {
      helper.replies.set(id, (reply) => {
        helper.replies.delete(id)
        resolve(reply)
      })
      helper.child.stdin?.write(
        `${JSON.stringify({ id, url: app.url, expiresAt: Date.now() + commandMs, request })}\n`,
      )
    })
  }

  return {
    async command(runId, app, request) {
      let helper = helpers.get(runId)
      if (helper?.busy || starting.has(runId))
        throw new RequestError(
          409,
          'A browser command is already running; try again when it finishes',
        )
      if (request.action !== 'open') {
        if (!helper?.app) throw new RequestError(409, 'Open a web App with ted browser open first')
        if (!sameApp(helper.app, app)) {
          stop(runId)
          throw new RequestError(409, 'The App restarted; run ted browser open again')
        }
      }
      if (!helper) {
        starting.add(runId)
        try {
          helper = await start(runId)
        } finally {
          starting.delete(runId)
        }
      }
      const current = helper
      current.busy = true
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const reply = await Promise.race([
          send(current, app, request),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              stop(runId)
              reject(
                new RequestError(409, 'The browser command timed out; run ted browser open again'),
              )
            }, commandMs + 2_000)
          }),
        ])
        if (reply.error !== undefined) throw new RequestError(409, reply.error)
        if (request.action === 'open') current.app = app
        return {
          ...(reply.url !== undefined && { url: reply.url }),
          ...(reply.text !== undefined && { text: reply.text }),
          ...(reply.capture !== undefined && { capture: Buffer.from(reply.capture, 'base64') }),
        }
      } finally {
        clearTimeout(timer)
        current.busy = false
      }
    },
    opened(runId) {
      const app = helpers.get(runId)?.app
      return app && { name: app.name, repo: app.repo }
    },
    close(runId, app) {
      const opened = helpers.get(runId)?.app
      if (
        app &&
        opened &&
        (opened.name !== app.name || (app.repo !== undefined && opened.repo !== app.repo))
      )
        return
      stop(runId)
    },
    closeAll() {
      for (const runId of [...helpers.keys()]) stop(runId)
    },
  }
}
