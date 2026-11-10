import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AutomationPromptDraft, RunSlots, RunWithConversation } from '@ted/protocol'
import { tedPaths } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { openStore } from '../src/store/index.ts'
import {
  api,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  stubCodexPath,
  tokenFor,
  waitUntil,
} from './helpers.ts'

let home: string
let scratch: string
let cleanup: () => Promise<void>
let daemon: RunningDaemon | undefined
let free = 500e9

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-draft-origin-'))
  await makeOriginRepo(scratch)
  free = 500e9
})
afterEach(async () => {
  await daemon?.stop()
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function start(add = true, timeout?: number, limitProbeMs?: number) {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    ...(limitProbeMs !== undefined && { limitProbeMs }),
    claudeBin: stubClaudePath,
    codexBin: stubCodexPath,
    automations: { ...(timeout !== undefined && { draftTimeoutMs: timeout }) },
    disk: { freeBytes: async () => free, checkEveryMs: 30 },
  })
  const client = api(daemon.port, { appKey: daemon.appToken })
  if (add) {
    const added = await client.call('POST', '/dev/factories', {
      repo: path.join(scratch, 'acme', 'widgets.git'),
      key: 'NB',
    })
    expect(added.status).toBe(201)
  }
  return client
}
type Client = Awaited<ReturnType<typeof start>>
const script = (...steps: unknown[]) => JSON.stringify({ steps })
async function request(client: Client, fields: Record<string, unknown> = {}) {
  const res = await client.call('POST', '/automation-prompt-drafts', {
    factory: 'NB',
    request: script({ say: 'Check bugs and create Tasks in Backlog.' }, { endTurn: true }),
    agent: 'claude',
    ...fields,
  })
  expect(res.status).toBe(201)
  return res.body as AutomationPromptDraft
}
async function read(client: Client, id: string) {
  const res = await client.call('GET', `/automation-prompt-drafts/${id}`)
  expect(res.status).toBe(200)
  return res.body as AutomationPromptDraft
}
async function until(client: Client, id: string, state: AutomationPromptDraft['state']) {
  return waitUntil(
    async () => {
      const draft = await read(client, id)
      return draft.state === state ? draft : undefined
    },
    `draft ${state}`,
    20_000,
  )
}

describe('Automation Prompt drafting', () => {
  test.each(['claude', 'codex'] as const)(
    'drafts with %s using the supplied model and context, without creating an Automation',
    async (agent) => {
      const client = await start()
      const gate = path.join(scratch, 'finish')
      const draft = await request(client, {
        request: script(
          { waitFor: gate },
          { say: 'Check bugs and create Tasks in Backlog.' },
          { endTurn: true },
        ),
        agent,
        model: agent === 'codex' ? 'gpt-6-astra' : 'opus',
        effort: 'high',
        name: 'Bug intake',
        prompt: 'Previous instructions',
      })
      await waitUntil(
        async () =>
          readFile(path.join(home, 'automation-drafts', draft.id, 'stub-record.json')).catch(
            () => undefined,
          ),
        'draft started',
      )
      const requests =
        agent === 'codex'
          ? await waitUntil(async () => {
              const text = await readFile(
                path.join(home, 'automation-drafts', draft.id, 'stub-requests.jsonl'),
                'utf8',
              ).catch(() => '')
              return text.includes('turn/start') ? text : undefined
            }, 'Codex turn started')
          : ''
      await writeFile(gate, '')
      const result = await until(client, draft.id, 'ready')
      expect(result.prompt).toBe('Check bugs and create Tasks in Backlog.')
      const run = (await client.call('GET', `/runs/${draft.id}`)).body as RunWithConversation
      expect(run.run.model).toBe(agent === 'codex' ? 'gpt-6-astra' : 'opus')
      expect(run.run.effort).toBe('high')
      expect(run.run.prompt).toContain('Previous instructions')
      expect(run.run.prompt).toContain('Bug intake')
      expect(run.run.prompt).toContain('--source')
      expect(run.run.taskId).toBeUndefined()
      const launch = JSON.parse(
        await readFile(path.join(home, 'runs', draft.id, 'launch.json'), 'utf8'),
      )
      if (agent === 'claude') {
        expect(
          launch.args.slice(launch.args.indexOf('--tools'), launch.args.indexOf('--tools') + 2),
        ).toEqual(['--tools', ''])
      } else {
        expect(launch.args).toContain('features.shell_tool=false')
        expect(launch.args).toContain('sandbox_mode="read-only"')
        expect(JSON.parse(launch.input).textOnly).toBe(true)
        const messages = requests
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        expect(messages.find((r) => r.method === 'thread/start')?.params).toMatchObject({
          sandbox: 'read-only',
          approvalPolicy: 'never',
          config: { mcp_servers: { external: { enabled: false } } },
        })
        expect(messages.find((r) => r.method === 'turn/start')?.params).toMatchObject({
          sandboxPolicy: { type: 'readOnly' },
          approvalPolicy: 'never',
        })
      }

      expect((await client.call('GET', '/automations')).body).toEqual([])
      expect((await client.call('GET', '/tasks')).body).toEqual([])
      await waitUntil(
        async () =>
          (await client.call('GET', `/runs/${draft.id}`)).body &&
          ((await client.call('GET', `/runs/${draft.id}`)).body as RunWithConversation).run
            .state === 'finished',
        'draft Run stopped',
      )
      await waitUntil(
        async () =>
          readFile(path.join(home, 'automation-drafts', draft.id, 'stub-record.json')).then(
            () => false,
            () => true,
          ),
        'draft folder removed',
      )
    },
  )

  test('validates input and refuses file and Run tokens', async () => {
    const client = await start()
    for (const fields of [
      { request: '' },
      { request: 1 },
      { factory: 'missing' },
      { agent: 'other' },
      { model: 'bad model' },
      { request: 'a'.repeat(10_001) },
      { prompt: 'a'.repeat(100_001) },
    ]) {
      expect(
        (
          await client.call('POST', '/automation-prompt-drafts', {
            factory: 'NB',
            request: 'Draft instructions',
            ...fields,
          })
        ).status,
      ).toBeGreaterThanOrEqual(400)
    }
    const draft = await request(client, {
      request: script({ waitFor: path.join(scratch, 'hold') }),
    })
    await until(client, draft.id, 'working')
    const file = api(daemon?.port ?? 0, await tokenFor(home))
    expect(
      (await file.call('POST', '/automation-prompt-drafts', { factory: 'NB', request: 'Draft' }))
        .status,
    ).toBe(403)
    expect((await file.call('GET', `/automation-prompt-drafts/${draft.id}`)).status).toBe(403)
    const tokens = await loadRunTokens(tedPaths(home).runTokenKey)
    const run = api(daemon?.port ?? 0, tokens.issue(draft.id))
    expect(
      (await run.call('POST', '/automation-prompt-drafts', { factory: 'NB', request: 'Draft' }))
        .status,
    ).toBe(403)
    expect((await run.call('DELETE', `/automation-prompt-drafts/${draft.id}`)).status).toBe(403)
    expect((await file.call('DELETE', `/automation-prompt-drafts/${draft.id}`)).status).toBe(403)
  })

  test('uses the queue and releases slots when canceled, ignoring late output', async () => {
    const client = await start()
    await client.call('PATCH', '/settings', { maxWorkingRuns: 1 })
    const first = await request(client, {
      request: script(
        { waitFor: path.join(scratch, 'release') },
        { say: 'Too late' },
        { endTurn: true },
      ),
    })
    await until(client, first.id, 'working')
    const second = await request(client)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect((await read(client, second.id)).state).toBe('queued')
    const slots = (await client.call('GET', '/slots')).body as RunSlots
    expect(slots.holders.some((h) => h.kind === 'automation-draft')).toBe(true)
    expect(slots.queue.some((q) => q.kind === 'automation-draft' && q.runId === second.id)).toBe(
      true,
    )
    expect((await client.call('DELETE', `/automation-prompt-drafts/${first.id}`)).status).toBe(200)
    await writeFile(path.join(scratch, 'release'), '')
    expect((await read(client, first.id)).state).toBe('canceled')
    expect((await read(client, first.id)).prompt).toBeUndefined()
    await until(client, second.id, 'ready')
  })

  test('cancels a queued draft before any Run starts and holds work while disk is full', async () => {
    const client = await start()
    await client.call('PATCH', '/settings', { maxWorkingRuns: 1 })
    const first = await request(client, {
      request: script({ waitFor: path.join(scratch, 'release') }),
    })
    await until(client, first.id, 'working')
    const second = await request(client)
    await client.call('DELETE', `/automation-prompt-drafts/${second.id}`)
    expect((await read(client, second.id)).state).toBe('canceled')
    expect((await client.call('GET', `/runs/${second.id}`)).status).toBe(404)
    free = 0
    await waitUntil(
      async () =>
        (
          await client.call('POST', '/automation-prompt-drafts', {
            factory: 'NB',
            request: 'Draft',
          })
        ).status === 409,
      'disk hold',
    )
  })

  test.each([
    { label: 'empty output', instructions: script({ endTurn: true }) },
    {
      label: 'oversized output',
      instructions: script({ lines: 1, everyMs: 0, pad: 100_001 }, { endTurn: true }),
    },
    { label: 'failed process', instructions: script({ exit: 1 }) },
    {
      label: 'unexpected tool',
      instructions: script({ permission: { tool: 'Bash', input: { command: 'echo unexpected' } } }),
    },
  ])('reports $label without saving anything', async ({ instructions }) => {
    const client = await start()
    const requestText = instructions
    const draft = await request(client, { request: requestText })
    const result = await until(client, draft.id, 'failed')
    expect(result.error).toBeTruthy()
    expect(result.prompt).toBeUndefined()
    expect((await client.call('GET', '/automations')).body).toEqual([])
  })

  test('times out an unfinished generation', async () => {
    const client = await start(true, 100)
    const draft = await request(client, {
      request: script({ waitFor: path.join(scratch, 'release') }),
    })
    expect((await until(client, draft.id, 'failed')).error).toContain('too long')
  })

  test('waits for agent health before starting a queued draft', async () => {
    await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ signedIn: false }))
    const client = await start()
    await client.call('POST', '/agents/health/check')
    const draft = await request(client)
    expect((await read(client, draft.id)).paused).toBeTruthy()
    expect((await read(client, draft.id)).state).toBe('queued')
    expect((await client.call('GET', `/runs/${draft.id}`)).status).toBe(404)
    await writeFile(path.join(home, 'stub-claude.json'), '{}')
    await client.call('POST', '/agents/health/check')
    await until(client, draft.id, 'ready')
  })

  test.each([
    ['claude', 'usage'],
    ['claude', 'auth'],
    ['codex', 'usage'],
    ['codex', 'auth'],
  ] as const)(
    'resumes a working %s draft after a %s pause and process exit',
    async (agent, cause) => {
      const client = await start(true, 1200, 2500)
      const release = path.join(scratch, 'pause')
      const resumeRelease = path.join(scratch, 'resume')
      const healthFile = path.join(home, `stub-${agent}.json`)
      const resumeSteps = [
        { waitFor: resumeRelease },
        { say: 'Recovered Prompt' },
        { endTurn: true },
      ]
      await writeFile(healthFile, JSON.stringify({ resumeSteps }))
      const draft = await request(client, {
        agent,
        request: script(
          { waitFor: release },
          cause === 'usage'
            ? agent === 'claude'
              ? { emit: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } } }
              : {
                  notify: 'error',
                  params: {
                    error: { message: 'Limit reached', codexErrorInfo: 'usageLimitExceeded' },
                    willRetry: false,
                  },
                }
            : { authError: true },
          { exit: 1 },
        ),
      })
      await waitUntil(
        async () =>
          readFile(path.join(home, 'automation-drafts', draft.id, 'stub-record.json')).catch(
            () => undefined,
          ),
        'first process started',
      )
      const original = await waitUntil(async () => {
        const run = (await client.call('GET', `/runs/${draft.id}`)).body as RunWithConversation
        return run.run.sessionId ? run : undefined
      }, 'session established')
      if (cause === 'auth')
        await writeFile(healthFile, JSON.stringify({ signedIn: false, resumeSteps }))
      await writeFile(release, '')
      await until(client, draft.id, 'queued')
      await waitUntil(async () => (await read(client, draft.id)).paused, 'draft paused')
      expect((await client.call('GET', `/runs/${draft.id}`)).body).toMatchObject({
        run: { state: 'finished' },
      })
      if (cause === 'auth') {
        await writeFile(healthFile, JSON.stringify({ resumeSteps }))
        await client.call('POST', '/agents/health/check')
      }
      await waitUntil(
        async () => {
          const starts = await readFile(
            path.join(home, 'automation-drafts', draft.id, 'stub-starts.jsonl'),
            'utf8',
          )
          return starts.trim().split('\n').length === 2
        },
        'draft session resumed',
        15_000,
      )
      const record = JSON.parse(
        await readFile(path.join(home, 'automation-drafts', draft.id, 'stub-record.json'), 'utf8'),
      )
      if (agent === 'claude') {
        expect(record.argv[record.argv.indexOf('--resume') + 1]).toBe(original.run.sessionId)
        expect(
          record.argv.slice(record.argv.indexOf('--tools'), record.argv.indexOf('--tools') + 2),
        ).toEqual(['--tools', ''])
      } else {
        expect(record.argv).toContain('features.shell_tool=false')
        const messages = await waitUntil(async () => {
          const text = await readFile(
            path.join(home, 'automation-drafts', draft.id, 'stub-requests.jsonl'),
            'utf8',
          )
          const messages = text
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
          return messages.some((m) => m.method === 'thread/resume') ? messages : undefined
        }, 'Codex thread resumed')
        expect(messages.find((m) => m.method === 'thread/resume')?.params).toMatchObject({
          threadId: original.run.sessionId,
          config: { mcp_servers: { external: { enabled: false } } },
        })
      }
      expect((await read(client, draft.id)).state).toBe('working')
      await writeFile(resumeRelease, '')
      expect((await until(client, draft.id, 'ready')).prompt).toBe('Recovered Prompt')
    },
  )

  test('a paused exit remains queued behind slots and disk holds, and cancellation prevents revival', async () => {
    const client = await start()
    await client.call('PATCH', '/settings', { maxWorkingRuns: 1 })
    const release = path.join(scratch, 'pause')
    const healthFile = path.join(home, 'stub-claude.json')
    const draft = await request(client, {
      request: script({ waitFor: release }, { authError: true }, { exit: 1 }),
    })
    await waitUntil(
      async () =>
        readFile(path.join(home, 'automation-drafts', draft.id, 'stub-record.json')).catch(
          () => undefined,
        ),
      'draft process started',
    )
    await writeFile(healthFile, JSON.stringify({ signedIn: false }))
    await writeFile(release, '')
    await until(client, draft.id, 'queued')
    await waitUntil(async () => (await read(client, draft.id)).paused, 'draft paused')
    const blocker = await request(client, {
      agent: 'codex',
      request: script({ waitFor: path.join(scratch, 'hold') }),
    })
    await until(client, blocker.id, 'working')
    await writeFile(healthFile, '{}')
    await client.call('POST', '/agents/health/check')
    expect((await read(client, draft.id)).state).toBe('queued')
    free = 0
    await waitUntil(
      async () =>
        (
          await client.call('POST', '/automation-prompt-drafts', {
            factory: 'NB',
            request: 'Draft',
          })
        ).status === 409,
      'disk hold',
    )
    await client.call('DELETE', `/automation-prompt-drafts/${blocker.id}`)
    expect((await read(client, draft.id)).state).toBe('queued')
    await client.call('DELETE', `/automation-prompt-drafts/${draft.id}`)
    free = 500e9
    await client.call('POST', '/agents/health/check')
    expect((await read(client, draft.id)).state).toBe('canceled')
    expect((await client.call('GET', `/runs/${draft.id}`)).body).toMatchObject({
      run: { state: 'finished' },
    })
  })

  test('removing a Factory stops its draft Runs and removes their records and folders', async () => {
    const client = await start()
    const draft = await request(client, {
      request: script({ waitFor: path.join(scratch, 'release') }),
    })
    await until(client, draft.id, 'working')
    const removed = await client.call('POST', `/factories/${draft.factoryId}/remove`, {
      key: 'NB',
      closePullRequests: false,
    })
    expect(removed.status).toBe(200)
    expect((await client.call('GET', `/automation-prompt-drafts/${draft.id}`)).status).toBe(404)
    expect((await client.call('GET', `/runs/${draft.id}`)).status).toBe(404)
    expect(
      await readFile(path.join(home, 'automation-drafts', draft.id, 'stub-record.json')).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  })

  test('keeps ready results across restart and interrupts unfinished work', async () => {
    let client = await start()
    const ready = await request(client)
    await until(client, ready.id, 'ready')
    await daemon?.stop()
    daemon = undefined
    const store = await openStore({ directory: tedPaths(home).store })
    const factory = store.listFactories()[0]
    if (!factory) throw new Error('No Factory')
    const interrupted = store.automationDrafts.create(factory.id, {
      factory: factory.id,
      request: 'Interrupted',
      agent: 'claude',
    })
    await store.persisted()
    await store.close()
    client = await start(false)
    expect((await read(client, ready.id)).prompt).toContain('Backlog')
    expect((await read(client, interrupted.id)).error).toContain('restarted')
    const retried = await request(client)
    await until(client, retried.id, 'ready')
  })
})
