import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Factory, Run, Task } from '@ted/protocol'
import { isString, type Json, type JsonObject } from '@ted/protocol/parse'
import { afterEach, beforeEach } from 'vitest'
import { type RunningDaemon, startDaemon } from '../../src/index.ts'
import {
  api,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  stubCodexPath,
  waitUntil,
} from '../helpers.ts'

export const ctx = {
  home: '',
  scratch: '',
  daemon: undefined as RunningDaemon | undefined,
  cleanup: async () => {},
}

export function useTaskLeadHarness(): void {
  beforeEach(async () => {
    const temp = await makeTempHome()
    ctx.home = temp.home
    ctx.cleanup = temp.cleanup
    ctx.scratch = await mkdtemp(path.join(tmpdir(), 'ted-origin-'))
    await makeOriginRepo(ctx.scratch)
  })

  afterEach(async () => {
    await ctx.daemon?.stop()
    ctx.daemon = undefined
    await killRunHosts(ctx.home)
    await ctx.cleanup()
    await rm(ctx.scratch, { recursive: true, force: true })
  })
}

export async function startTed() {
  ctx.daemon = await startDaemon({
    home: ctx.home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    codexBin: stubCodexPath,
  })
  const client = connect(ctx.daemon)

  await client.ok<Factory>('POST', '/dev/factories', {
    repo: path.join(ctx.scratch, 'acme', 'widgets.git'),
    key: 'NB',
  })
  return client
}

export function connect(daemon: RunningDaemon) {
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: Json): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  return { ...client, ok }
}

export type Client = Awaited<ReturnType<typeof startTed>>

export const steps = (...list: Json[]) => JSON.stringify({ steps: list })

const worktreeFile = (name: string) => path.join(ctx.home, 'worktrees', 'NB-1', 'widgets', name)

const jsonLines = async <T>(name: string): Promise<T[]> =>
  (await readFile(worktreeFile(name), 'utf8').catch(() => ''))
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as T)

export const claudeStarts = () => jsonLines<{ argv: string[] }>('stub-starts.jsonl')

export const codexRequests = () =>
  jsonLines<{ method?: string; params?: JsonObject }>('stub-requests.jsonl')

export const flag = (argv: string[], name: string) =>
  argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined

export const getTask = async (client: Client, id: string) =>
  (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)

export const leadRun = async (client: Client, task: Task): Promise<Run> => {
  const current = await getTask(client, task.id)
  if (!current?.leadRunId) throw new Error(`no Task Lead Run for ${task.displayId}`)
  return (await client.getRun(current.leadRunId)).run
}

export const waitForRun = (
  client: Client,
  task: Task,
  check: (run: Run) => boolean,
  what: string,
  timeoutMs?: number,
) =>
  waitUntil(
    async () => {
      const run = await leadRun(client, task).catch(() => undefined)
      return run && check(run) ? run : undefined
    },
    what,
    timeoutMs,
  )

export const userMessages = async (client: Client, runId: string) =>
  (await client.getRun(runId)).conversation.flatMap((e) => {
    const line = JSON.parse(e.line) as { type: string; message?: { content?: Json } }
    const content = line.message?.content
    return line.type === 'user' && isString(content) ? [content] : []
  })
