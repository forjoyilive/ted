import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  Banner,
  Comment,
  Factory,
  InboxItem,
  MachineSettings,
  Run,
  SubAgent,
  Task,
  ThreadEvent,
} from '@ted/protocol'
import { readDaemonInfo, tedPaths } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { isLockHeld } from '../src/lock.ts'
import { nodeEntry } from '../src/node-entry.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { forGeneration, hostProtocol } from '../src/runs/host-files.ts'
import {
  api,
  assistantTexts,
  commitToOrigin,
  hostRecords,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  spawnDaemonProcess,
  stubClaudePath,
  stubCodexPath,
  testAppToken,
  tokenFor,
  waitUntil,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let daemon: RunningDaemon | undefined
let daemonChild: ChildProcess | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-permissions-'))
  origin = await makeOriginRepo(scratch)
})

afterEach(async () => {
  if (daemonChild) {
    daemonChild.kill('SIGKILL')
    await once(daemonChild, 'exit')
    daemonChild = undefined
  }
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function start(workflow = 'version: 1\n', detached = false, runs?: { stopGraceMs: number }) {
  await commitToOrigin(scratch, { '.ted/workflow.yaml': workflow })
  let port: number
  let appKey: string
  if (detached) {
    daemonChild = spawnDaemonProcess([], {
      ...process.env,
      TED_HOME: home,
      TED_CLAUDE_BIN: stubClaudePath,
      TED_CODEX_BIN: stubCodexPath,
    })
    port = (await waitUntil(() => readDaemonInfo(home), 'daemon.json')).port
    appKey = testAppToken
  } else {
    daemon = await startDaemon({
      home,
      version: '9.9.9',
      claudeBin: stubClaudePath,
      codexBin: stubCodexPath,
      ...(runs && { runs }),
    })
    port = daemon.port
    appKey = daemon.appToken
  }
  const client = api(port, { appKey })
  const fileToken = api(port, await tokenFor(home))
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  return { ...client, ok, fileToken }
}

type Client = Awaited<ReturnType<typeof start>>

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })

async function startTask(
  client: Client,
  list: unknown[],
  lead?: { agent: 'claude' | 'codex' },
): Promise<Task> {
  const task = await client.ok<Task>('POST', '/tasks', {
    title: steps(...list),
    factory: 'NB',
    ...(lead && { lead }),
  })
  await client.ok('POST', `/tasks/${task.id}/start`)
  return task
}

const getTask = async (client: Client, id: string) => {
  const task = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)
  if (!task) throw new Error(`no Task ${id}`)
  return task
}

const comments = (client: Client, task: Task) =>
  client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)

const permissionOf = (client: Client, task: Task) =>
  waitUntil(
    async () => (await comments(client, task)).find((c) => c.kind === 'permission'),
    'a permission request',
  )

const permissions = async (client: Client, task: Task) =>
  (await comments(client, task)).filter((c) => c.kind === 'permission')

const permissionAt = (client: Client, task: Task, index: number) =>
  waitUntil(async () => (await permissions(client, task))[index], `permission request ${index + 1}`)

const leadRun = async (client: Client, task: Task): Promise<Run> => {
  const id = await waitUntil(
    async () => (await getTask(client, task.id)).leadRunId,
    'a Task Lead Run',
  )
  return (await client.getRun(id)).run
}

const said = async (client: Client, runId: string) =>
  assistantTexts((await client.getRun(runId)).conversation)

const bash = (command: string, description: string) => ({
  permission: { tool: 'Bash', input: { command, description }, description },
})

async function waitingLegacyRun() {
  const initial = await start('version: 1\n', true)
  const [factory] = await initial.ok<Factory[]>('GET', '/factories')
  const route = `/factories/${factory?.id}/permissions`
  const task = await startTask(initial, [
    bash('echo waiting', 'Wait before update'),
    { endTurn: true },
  ])
  const run = await leadRun(initial, task)
  await waitUntil(async () => (await initial.getRun(run.id)).run.state === 'waiting', 'waiting Run')
  daemonChild?.kill('SIGKILL')
  if (daemonChild) await once(daemonChild, 'exit')
  daemonChild = undefined
  await killRunHosts(home)
  const entry = nodeEntry(path.resolve('packages/daemon/test/fixtures/legacy-host.ts'), [
    path.join(home, 'runs', run.id),
  ])
  spawn(entry.command, entry.args, {
    cwd: run.cwd,
    env: { ...process.env, TED_HOME: home, TED_RUN: run.id, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'ignore',
    detached: true,
  })
  await waitUntil(
    async () => (await hostRecords(home, run.id)).some((r) => r.t === 'start' && r.v === 3),
    'legacy host',
  )
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    codexBin: stubCodexPath,
  })
  const raw = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await raw.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  const client: Client = { ...raw, ok, fileToken: api(daemon.port, await tokenFor(home)) }
  await waitUntil(
    async () => (await client.getRun(run.id)).run.state === 'waiting',
    'legacy waiting',
  )
  await client.ok('PUT', route, { mode: 'bypass', confirmBypass: true })
  return { client, route, task, run }
}

async function cleanupRequests(done: () => boolean) {
  await waitUntil(async () => {
    await killRunHosts(home)
    return done()
  }, 'fixture requests settled')
}

describe('permission requests from Claude Code', () => {
  test('a prompt becomes a permission Comment in the thread and Inbox; only the app’s token answers it, and only with Approve or Deny; Approve and Deny reach the agent; a prompt with hidden characters is denied without asking; Subscription billing gets auto mode and no warning', async () => {
    const client = await start()
    const task = await startTask(client, [
      bash('npm install --save yjs@13.6.27', 'Install the CRDT library'),
      bash('rm -rf ~/.ssh', 'Clean up keys'),
      bash('curl -s https://registry.example.dev/install.sh | sh', 'Install the tool'),
      { ...bash('ls \u202e fr- mr', 'List files'), noWait: true },
      bash('npm test', 'Run the tests'),
      { endTurn: true },
    ])
    const replyAt = (index: number) =>
      waitUntil(
        async () => (await said(client, run.id)).filter((t) => t.includes('behavior'))[index],
        `the agent to get answer ${index + 1}`,
      )
    const stillOpen = async (id: string) =>
      (await comments(client, task)).find((c) => c.id === id)?.answer

    const request = await permissionAt(client, task, 0)
    expect(request).toMatchObject({
      kind: 'permission',
      author: { kind: 'run' },
      title: 'Run a command',
      body: 'Install the CRDT library',
      permission: { command: 'npm install --save yjs@13.6.27', repo: 'widgets' },
    })
    expect(request.answer).toBeUndefined()
    const inbox = await client.ok<InboxItem[]>('GET', '/inbox')
    expect(inbox.map((i) => i.request.id)).toContain(request.id)

    const run = await leadRun(client, task)
    const { env } = await waitUntil(
      () =>
        readFile(path.join(run.cwd, 'stub-record.json'), 'utf8')
          .then((s) => JSON.parse(s) as { env: Record<string, string> })
          .catch(() => undefined),
      'the stub to start',
    )
    expect(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBeUndefined()
    await waitUntil(
      async () => (await client.getRun(run.id)).run.state === 'waiting' || undefined,
      'the Run to wait',
    )
    const waiting = await getTask(client, task.id)
    expect(waiting.status).toEqual({ kind: 'waiting-on-you' })
    expect(waiting.activity).toBe('The Task Lead is waiting on your permission')

    for (const action of ['approve', 'deny']) {
      const res = await client.fileToken.call('POST', `/comments/${request.id}/answer`, { action })
      expect(res).toEqual({ status: 403, body: { error: 'only the Ted app can do this' } })
    }
    expect(await stillOpen(request.id)).toBeUndefined()

    const token = (await loadRunTokens(tedPaths(home).runTokenKey)).issue(run.id)
    const asRun = api(daemon?.port ?? 0, token)
    const fromRun = await asRun.call('POST', `/comments/${request.id}/answer`, {
      action: 'approve',
    })
    expect(fromRun.status).toBe(403)
    expect(await stillOpen(request.id)).toBeUndefined()

    const question = await client.call('POST', `/comments/${request.id}/answer`, {
      action: 'answer',
      text: 'sure',
    })
    expect(question.status).toBe(400)
    expect(await stillOpen(request.id)).toBeUndefined()

    const approved = await client.ok<Comment>('POST', `/comments/${request.id}/answer`, {
      action: 'approve',
    })
    expect(approved.answer).toMatchObject({ kind: 'approved' })
    expect(JSON.parse(await replyAt(0))).toEqual({
      behavior: 'allow',
      updatedInput: {
        command: 'npm install --save yjs@13.6.27',
        description: 'Install the CRDT library',
      },
    })
    expect((await client.ok<InboxItem[]>('GET', '/inbox')).map((i) => i.request.id)).not.toContain(
      request.id,
    )

    const second = await permissionAt(client, task, 1)
    expect(second.permission?.command).toBe('rm -rf ~/.ssh')
    const denied = await client.ok<Comment>('POST', `/comments/${second.id}/answer`, {
      action: 'deny',
    })
    expect(denied.answer).toMatchObject({ kind: 'denied' })
    expect(JSON.parse(await replyAt(1))).toMatchObject({ behavior: 'deny' })

    const third = await permissionAt(client, task, 2)
    expect(third.permission?.command).toBe('curl -s https://registry.example.dev/install.sh | sh')
    const deniedWithText = await client.ok<Comment>('POST', `/comments/${third.id}/answer`, {
      action: 'deny',
      text: 'Use npm, not an install script.',
    })
    expect(deniedWithText.answer).toMatchObject({
      kind: 'denied',
      text: 'Use npm, not an install script.',
    })
    expect(JSON.parse(await replyAt(2))).toEqual({
      behavior: 'deny',
      message: 'The human denied this request and said:\n\nUse npm, not an install script.',
    })
    const again = await client.call('POST', `/comments/${third.id}/answer`, {
      action: 'approve',
    })
    expect(again.status).toBe(409)

    const fourth = await permissionAt(client, task, 3)
    expect(fourth.permission?.command).toBe('npm test')
    expect((await permissions(client, task)).map((c) => c.permission?.command)).toEqual([
      'npm install --save yjs@13.6.27',
      'rm -rf ~/.ssh',
      'curl -s https://registry.example.dev/install.sh | sh',
      'npm test',
    ])

    await client.ok('POST', `/comments/${fourth.id}/answer`, { action: 'approve' })
    await waitUntil(
      async () => (await client.getRun(run.id)).run.state === 'idle',
      'the turn to end',
    )
    expect((await permissions(client, task)).map((c) => c.id)).toEqual([
      request.id,
      second.id,
      third.id,
      fourth.id,
    ])
    expect((await client.getRun(run.id)).run.manualPermissions).toBeFalsy()
    const banners = await client.ok<Banner[]>('GET', '/banners')
    expect(banners.some((b) => b.problem === 'auto-mode-unavailable')).toBe(false)
  })
})

describe('answers and withdrawals', () => {
  test('stopping the Run withdraws its open permission request', async () => {
    const client = await start()
    const task = await startTask(client, [bash('rm -rf .cache', 'Clear the cache')])
    const request = await permissionOf(client, task)
    const run = await leadRun(client, task)

    const { pid } = JSON.parse(await readFile(path.join(run.cwd, 'stub-record.json'), 'utf8')) as {
      pid: number
    }
    process.kill(pid, 'SIGTERM')

    const withdrawn = await waitUntil(async () => {
      const c = (await comments(client, task)).find((x) => x.id === request.id)
      return c?.answer ? c : undefined
    }, 'the request to be withdrawn')
    expect(withdrawn.answer).toMatchObject({ kind: 'withdrawn', runStopped: true })
    const inbox = await client.ok<InboxItem[]>('GET', '/inbox')
    expect(inbox.map((i) => i.request.id)).not.toContain(request.id)
    const res = await client.call('POST', `/comments/${request.id}/answer`, { action: 'approve' })
    expect(res.status).toBe(409)
  })
})

describe('permission modes', () => {
  test('when Claude’s auto mode isn’t available the Run is marked manual and the thread says so', async () => {
    await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ autoUnavailable: true }))
    const client = await start()
    const task = await startTask(client, [{ endTurn: true }])
    const run = await leadRun(client, task)

    const marked = await waitUntil(async () => {
      const r = (await client.getRun(run.id)).run
      return r.manualPermissions ? r : undefined
    }, 'the Run to be marked manual')
    expect(marked.permissions).toBe('auto')
    const lines = await client.ok<ThreadEvent[]>('GET', `/tasks/${task.id}/events`)
    expect(lines.map((l) => l.text)).toContain(
      'Claude Code’s auto mode isn’t available, so every permission prompt comes to you',
    )
    const banner = await waitUntil(
      async () =>
        (await client.ok<Banner[]>('GET', '/banners')).find(
          (b) => b.problem === 'auto-mode-unavailable',
        ),
      'the auto mode warning',
    )
    expect(banner).toMatchObject({
      severity: 'warning',
      factoryId: task.factoryId,
      text: 'Claude Code’s auto mode isn’t available · every permission prompt comes to the Inbox',
    })

    await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({}))
    await startTask(client, [{ endTurn: true }])
    await waitUntil(
      async () =>
        !(await client.ok<Banner[]>('GET', '/banners')).some(
          (b) => b.problem === 'auto-mode-unavailable',
        ),
      'the auto mode warning to clear once a Run gets auto mode',
    )
  })

  test('under API key billing Claude Code scrubs credentials, which turns off auto mode; the warning says so', async () => {
    const client = await start()
    await client.ok('PATCH', '/settings', { billing: { claude: 'api-key', codex: 'subscription' } })
    const task = await startTask(client, [{ endTurn: true }])
    const run = await leadRun(client, task)
    await waitUntil(
      async () => (await client.getRun(run.id)).run.manualPermissions,
      'the Run to be marked manual',
    )
    const banner = await waitUntil(
      async () =>
        (await client.ok<Banner[]>('GET', '/banners')).find(
          (b) => b.problem === 'auto-mode-unavailable',
        ),
      'the auto mode warning',
    )
    expect(banner.text).toBe(
      'Claude Code’s auto mode is off under API key billing, because Ted keeps the key out of the commands Claude runs · every permission prompt comes to the Inbox',
    )
  })

  test('local consent starts Claude Code with bypassPermissions even when the repo says Auto', async () => {
    const client = await start('version: 1\npermissions: auto\n')
    const [factory] = await client.ok<Factory[]>('GET', '/factories')
    await client.ok('PUT', `/factories/${factory?.id}/permissions`, {
      mode: 'bypass',
      confirmBypass: true,
    })
    const task = await startTask(client, [{ endTurn: true }])
    const run = await leadRun(client, task)
    expect(run.permissions).toBe('bypass')
    const { argv } = await waitUntil(
      () =>
        readFile(path.join(run.cwd, 'stub-record.json'), 'utf8')
          .then((s) => JSON.parse(s) as { argv: string[] })
          .catch(() => undefined),
      'the stub to start',
    )
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('bypassPermissions')
  })
})

describe('permission requests from Codex', () => {
  test('a Codex approval request becomes a permission Comment and Approve accepts it; Codex gets exactly the access the card showed; a file change shows the diff; a command shows where it runs; a legacy command shows quoted arguments; a request Ted can’t show is denied without asking; a directory that only looks like the worktree gets no repo label', async () => {
    const client = await start()
    const diff = '@@ -1 +1 @@\n-old\n+new\n'
    const outside = `${home}/worktrees/NB-1/widgets/../../../evil`
    const task = await startTask(
      client,
      [
        { approval: 'command', command: 'git commit -m "Add sync"' },
        {
          approval: 'permissions',
          permissions: { network: null, fileSystem: { read: null, write: ['/tmp/cache'] } },
        },
        {
          approval: 'permissions',
          permissions: { network: { enabled: true }, macos: { accessibility: true } },
        },
        { approval: 'fileChange', changes: [{ path: '/repo/.git/config', diff }] },
        { approval: 'fileChange' },
        { approval: 'command', command: 'rm -rf ./*', cwd: '/Users/someone' },
        { approval: 'command', command: 'ls', extra: { sandboxOverride: 'none' } },
        { legacyApproval: ['sh', '-c', "echo 'hi' && rm -rf build"] },
        { legacyApproval: ['ls'], extra: { escalate: true } },
        { legacyApproval: ['ls', 7] },
        { approval: 'command', command: 'ls', cwd: outside },
        { endTurn: true },
      ],
      { agent: 'codex' },
    )
    expect(task.displayId).toBe('NB-1')
    let asked = 0
    let heard = 0
    const nextRequest = () => permissionAt(client, task, asked++)
    const nextReplies = async (count: number, marker: string) => {
      const from = heard
      heard += count
      const texts = await waitUntil(async () => {
        const all = await said(client, run.id)
        return all.length >= heard ? all : undefined
      }, `Codex to get ${count} more answers`)
      const fresh = texts.slice(from, heard)
      expect(fresh.every((t) => t.includes(marker))).toBe(true)
      return fresh.map((t) => JSON.parse(t))
    }

    const command = await nextRequest()
    expect(command).toMatchObject({
      title: 'Run a command outside the sandbox',
      body: 'git needs to write outside the workspace',
      permission: { command: 'git commit -m "Add sync"', repo: 'widgets' },
    })
    const run = await leadRun(client, task)
    await client.ok('POST', `/comments/${command.id}/answer`, { action: 'approve' })
    expect(await nextReplies(1, 'decision')).toEqual([{ decision: 'accept' }])

    const access = await nextRequest()
    expect(access).toMatchObject({
      title: 'Get more access',
      permission: { command: 'write /tmp/cache' },
    })
    await client.ok('POST', `/comments/${access.id}/answer`, { action: 'approve' })
    expect(await nextReplies(2, 'scope')).toEqual([
      { permissions: { fileSystem: { read: null, write: ['/tmp/cache'] } }, scope: 'turn' },
      { permissions: {}, scope: 'turn' },
    ])

    const change = await nextRequest()
    expect(change.title).toBe('Change files')
    expect(change.permission?.command).toBe('/repo/.git/config')
    expect(change.permission?.details).toContain('+new')
    await client.ok('POST', `/comments/${change.id}/answer`, { action: 'approve' })
    expect(await nextReplies(2, 'decision')).toEqual([
      { decision: 'accept' },
      { decision: 'decline' },
    ])

    const elsewhere = await nextRequest()
    expect(elsewhere.permission).toEqual({
      command: 'rm -rf ./*',
      details: 'Runs in /Users/someone',
    })
    await client.ok('POST', `/comments/${elsewhere.id}/answer`, { action: 'deny' })
    expect(await nextReplies(2, 'decision')).toEqual([
      { decision: 'decline' },
      { decision: 'decline' },
    ])

    const legacy = await nextRequest()
    expect(legacy.permission?.command).toBe(`sh -c 'echo '\\''hi'\\'' && rm -rf build'`)
    await client.ok('POST', `/comments/${legacy.id}/answer`, { action: 'approve' })
    expect((await nextReplies(3, 'decision')).map((reply) => reply.decision)).toEqual([
      'approved',
      { denied: { rejection: 'The human denied this request' } },
      { denied: { rejection: 'The human denied this request' } },
    ])

    const lookalike = await nextRequest()
    expect(lookalike.permission).toEqual({ command: 'ls', details: `Runs in ${outside}` })
    expect((await permissions(client, task)).map((c) => c.id)).toEqual([
      command.id,
      access.id,
      change.id,
      elsewhere.id,
      legacy.id,
      lookalike.id,
    ])
    expect(await said(client, run.id)).toHaveLength(heard)
  })
})

describe('who can answer, and what an answer covers', () => {
  test('an answer meant for an agent that has since restarted never reaches the new one', async () => {
    const client = await start()
    const task = await startTask(client, [bash('npm test', 'Run the tests'), { endTurn: true }])
    const first = await permissionOf(client, task)
    const run = await leadRun(client, task)
    const runDir = path.join(home, 'runs', run.id)
    const { hostPid } = JSON.parse(
      (await readFile(path.join(runDir, 'host.log'), 'utf8')).split('\n')[0] ?? '{}',
    ) as { hostPid: number }
    const launchPath = path.join(runDir, 'launch.json')
    const launch = JSON.parse(await readFile(launchPath, 'utf8')) as Record<string, unknown>
    await writeFile(
      launchPath,
      JSON.stringify({ ...launch, launchId: 'prepared-restart-for-stale-reply' }),
    )
    process.kill(hostPid, 'SIGHUP')

    const second = await waitUntil(
      async () =>
        (await comments(client, task)).find((c) => c.kind === 'permission' && c.id !== first.id),
      'the restarted agent to ask again',
    )
    const withdrawn = (await comments(client, task)).find((c) => c.id === first.id)
    expect(withdrawn?.answer).toMatchObject({ kind: 'withdrawn', runStopped: true })

    const stale = JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-1',
        response: { behavior: 'allow', updatedInput: {} },
      },
    })
    await appendFile(path.join(runDir, 'input.jsonl'), `${forGeneration(1, stale)}\n`)
    await client.ok('POST', `/comments/${second.id}/answer`, { action: 'deny' })

    const reply = await waitUntil(async () => {
      const texts = await said(client, run.id)
      return texts.find((t) => t.includes('behavior'))
    }, 'the agent to get an answer')
    expect(JSON.parse(reply)).toMatchObject({ behavior: 'deny' })
  })

  test('a request and the Run’s exit in one batch leave the request withdrawn, not open', async () => {
    const client = await start()
    const task = await startTask(client, [
      { ...bash('make deploy', 'Deploy'), noWait: true },
      { exit: 0 },
    ])
    const request = await waitUntil(
      async () => (await comments(client, task)).find((c) => c.kind === 'permission' && c.answer),
      'the request to be withdrawn',
    )
    expect(request.answer).toMatchObject({ kind: 'withdrawn', runStopped: true })
    expect((await client.ok<InboxItem[]>('GET', '/inbox')).length).toBe(0)
  })

  test('Stop Task withdraws the Task Lead’s open permission request', async () => {
    const client = await start()
    const task = await startTask(client, [bash('npm publish', 'Publish the package')])
    const request = await permissionOf(client, task)
    await client.ok('POST', `/tasks/${task.id}/stop`)
    const withdrawn = await waitUntil(async () => {
      const c = (await comments(client, task)).find((x) => x.id === request.id)
      return c?.answer ? c : undefined
    }, 'the request to be withdrawn')
    expect(withdrawn.answer).toMatchObject({ kind: 'withdrawn', runStopped: true })
  })
})

describe('local Factory permission consent', () => {
  test('a committed Bypass request stays in Auto and raises a banner; only confirmed app requests enable it', async () => {
    const client = await start('version: 1\npermissions: bypass\n')
    const task = await startTask(client, [{ endTurn: true }])
    const run = await leadRun(client, task)
    expect(run.permissions).toBe('auto')
    const route = `/factories/${task.factoryId}/permissions`
    const banners = () => client.ok<Banner[]>('GET', '/banners')
    expect(await banners()).toContainEqual(
      expect.objectContaining({ problem: 'repo-requests-bypass', factoryId: task.factoryId }),
    )
    const asRun = api(
      daemon?.port ?? 0,
      (await loadRunTokens(tedPaths(home).runTokenKey)).issue(run.id),
    )
    const subAgent = async (expected: 'auto' | 'bypass') => {
      const response = await asRun.call('POST', `/tasks/${task.id}/sub-agents`, {
        prompt: steps({ endTurn: true }),
        name: `Child ${expected}`,
      })
      expect(response.status).toBe(201)
      const child = response.body as SubAgent
      const started = await waitUntil(async () => {
        const found = await client.call('GET', `/runs/${child.id}`)
        return found.status === 200 ? (found.body as { run: Run }).run : undefined
      }, 'the sub-agent to start')
      expect(started.permissions).toBe(expected)
    }
    await subAgent('auto')
    for (const caller of [asRun, client.fileToken]) {
      expect(
        (await caller.call('PUT', route, { mode: 'bypass', confirmBypass: true })).status,
      ).toBe(403)
    }
    expect((await client.call('PUT', route, { mode: 'bypass' })).status).toBe(409)
    expect(
      (await client.call('PUT', route, { mode: 'bypass', confirmBypass: 'true' })).status,
    ).toBe(409)
    expect((await client.call('PUT', route, { mode: 'other' })).status).toBe(400)
    expect(
      (await client.call('PUT', '/factories/missing/permissions', { mode: 'auto' })).status,
    ).toBe(404)
    expect(
      (
        await client.call('PATCH', '/settings', {
          factoryPermissions: { [task.factoryId]: 'bypass' },
        })
      ).status,
    ).toBe(400)
    const notifications = `/factories/${task.factoryId}/notifications`
    for (const caller of [asRun, client.fileToken]) {
      expect((await caller.call('PUT', notifications, { inboxItems: false })).status).toBe(403)
    }
    expect((await client.call('PUT', notifications, {})).status).toBe(400)
    expect(
      (await client.call('PUT', '/factories/missing/notifications', { inboxItems: false })).status,
    ).toBe(404)
    await client.ok('PUT', notifications, { inboxItems: false })
    expect(
      await client.ok<MachineSettings>('PUT', notifications, { taskMerged: true }),
    ).toMatchObject({
      factoryNotifications: { [task.factoryId]: { inboxItems: false, taskMerged: true } },
    })
    await client.ok('PUT', route, { mode: 'bypass', confirmBypass: true })
    expect((await banners()).some((b) => b.problem === 'repo-requests-bypass')).toBe(false)
    await subAgent('bypass')
    // Changing consent does not interrupt or relabel the already running process.
    expect((await client.getRun(run.id)).run.permissions).toBe('auto')
    const next = await leadRun(
      client,
      await startTask(client, [{ endTurn: true }], { agent: 'codex' }),
    )
    expect(next.permissions).toBe('bypass')
    const record = await waitUntil(
      () =>
        readFile(path.join(next.cwd, 'stub-record.json'), 'utf8')
          .then((s) => (s.includes('danger-full-access') ? s : undefined))
          .catch(() => undefined),
      'Codex Bypass arguments',
    )
    expect(record).toContain('danger-full-access')
    await client.ok('PUT', route, { mode: 'auto' })
    expect(await banners()).toContainEqual(
      expect.objectContaining({ problem: 'repo-requests-bypass' }),
    )
  })

  test('revoking consent takes effect on restart and on recovery after an unprepared host restart', async () => {
    const client = await start()
    const [factory] = await client.ok<Factory[]>('GET', '/factories')
    const route = `/factories/${factory?.id}/permissions`
    await client.ok('PUT', route, { mode: 'bypass', confirmBypass: true })
    const task = await startTask(client, [{ endTurn: true }])
    const run = await leadRun(client, task)
    await waitUntil(async () => (await client.getRun(run.id)).run.state === 'idle', 'idle Run')
    await client.ok('PUT', route, { mode: 'auto' })
    await client.ok('POST', `/runs/${run.id}/restart`)
    await waitUntil(
      async () => (await hostRecords(home, run.id)).filter((r) => r.t === 'start').length >= 2,
      'restart',
    )
    expect((await client.getRun(run.id)).run.permissions).toBe('auto')
    const record = JSON.parse(await readFile(path.join(run.cwd, 'stub-record.json'), 'utf8')) as {
      argv: string[]
    }
    expect(record.argv[record.argv.indexOf('--permission-mode') + 1]).toBe('auto')
    await waitUntil(
      async () => (await client.getRun(run.id)).run.state === 'idle',
      'idle after restart',
    )
    await client.ok('PUT', route, { mode: 'bypass', confirmBypass: true })
    const recoveringTask = await startTask(client, [{ endTurn: true }])
    const recovering = await leadRun(client, recoveringTask)
    await waitUntil(
      async () => (await client.getRun(recovering.id)).run.state === 'idle',
      'second idle Run',
    )
    await client.ok('PUT', route, { mode: 'auto' })
    const starts = (await hostRecords(home, recovering.id)).filter((r) => r.t === 'start')
    process.kill(Number(starts.at(-1)?.hostPid), 'SIGHUP')
    await waitUntil(
      async () =>
        (await hostRecords(home, recovering.id)).filter((r) => r.t === 'start').length >= 2,
      'daemon recovery',
    )
    await waitUntil(
      async () => (await client.getRun(recovering.id)).run.permissions === 'auto',
      'recovered process mode recorded',
    )
  })

  test('a permission save waits for a pending agent handoff before it takes effect', async () => {
    const client = await start()
    const [factory] = await client.ok<Factory[]>('GET', '/factories')
    const route = `/factories/${factory?.id}/permissions`
    await client.ok('PUT', route, { mode: 'bypass', confirmBypass: true })
    const task = await startTask(client, [{ endTurn: true }])
    const run = await leadRun(client, task)
    await waitUntil(async () => (await client.getRun(run.id)).run.state === 'idle', 'idle Run')
    const gate = path.join(scratch, 'shutdown')
    await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ stopWaitsFor: gate }))
    const restarting = client.ok('POST', `/runs/${run.id}/restart`)
    await waitUntil(
      () =>
        readFile(`${gate}.waiting`)
          .then(() => true)
          .catch(() => false),
      'shutdown gate',
    )
    let saved = false
    const saving = client.ok('PUT', route, { mode: 'auto' }).then(() => {
      saved = true
    })
    try {
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(saved).toBe(false)
    } finally {
      await writeFile(gate, '')
      await Promise.all([restarting, saving])
    }
    await waitUntil(async () => (await client.getRun(run.id)).run.state === 'idle', 'restarted Run')
    await client.ok('POST', `/runs/${run.id}/restart`)
    const started = (await hostRecords(home, run.id)).filter((r) => r.t === 'start').at(-1)
    const record = await waitUntil(async () => {
      const latest = JSON.parse(await readFile(path.join(run.cwd, 'stub-record.json'), 'utf8')) as {
        pid: number
        argv: string[]
      }
      return latest.pid === started?.agentPid ? latest : undefined
    }, 'restarted agent arguments')
    expect(record.argv[record.argv.indexOf('--permission-mode') + 1]).toBe('auto')
    expect((await client.getRun(run.id)).run.permissions).toBe('auto')
  })

  test.each(['auto', 'bypass'] as const)(
    'a waiting legacy %s host restarts with current consent and recorded mode',
    async (previous) => {
      const client = await start('version: 1\n', true)
      const [factory] = await client.ok<Factory[]>('GET', '/factories')
      const route = `/factories/${factory?.id}/permissions`
      if (previous === 'bypass')
        await client.ok('PUT', route, { mode: previous, confirmBypass: true })
      const task = await startTask(client, [
        bash('echo waiting', 'Wait before update'),
        { endTurn: true },
      ])
      const run = await leadRun(client, task)
      await waitUntil(
        async () => (await client.getRun(run.id)).run.state === 'waiting',
        'waiting Run',
      )
      daemonChild?.kill('SIGKILL')
      if (daemonChild) await once(daemonChild, 'exit')
      daemonChild = undefined
      await killRunHosts(home)
      const entry = nodeEntry(path.resolve('packages/daemon/test/fixtures/legacy-host.ts'), [
        path.join(home, 'runs', run.id),
      ])
      const legacy = spawn(entry.command, entry.args, {
        cwd: run.cwd,
        env: { ...process.env, TED_HOME: home, TED_RUN: run.id, ELECTRON_RUN_AS_NODE: '1' },
        stdio: 'ignore',
        detached: true,
      })
      try {
        await waitUntil(
          async () => (await hostRecords(home, run.id)).some((r) => r.t === 'start' && r.v === 3),
          'legacy host started',
        )
        daemon = await startDaemon({
          home,
          version: '9.9.9',
          claudeBin: stubClaudePath,
          codexBin: stubCodexPath,
        })
        const reopened = api(daemon.port, { appKey: daemon.appToken })
        await waitUntil(
          async () => (await reopened.getRun(run.id)).run.state === 'waiting',
          'legacy host waiting',
        )
        const next = previous === 'auto' ? 'bypass' : 'auto'
        expect(
          (await reopened.call('PUT', route, { mode: next, confirmBypass: true })).status,
        ).toBe(200)
        const gate = path.join(scratch, 'resumed-legacy')
        await writeFile(
          path.join(home, 'stub-claude.json'),
          JSON.stringify({ resumeWaitsFor: gate }),
        )
        try {
          expect((await reopened.call('POST', `/runs/${run.id}/restart`)).status).toBe(200)
          expect((await reopened.getRun(run.id)).run.permissions).toBe(next)
          const record = await waitUntil(
            () =>
              readFile(path.join(run.cwd, 'stub-record.json'), 'utf8').then((s) => {
                const r = JSON.parse(s) as { argv: string[] }
                return r.argv.includes('--resume') ? r : undefined
              }),
            'replacement arguments',
          )
          expect(record.argv[record.argv.indexOf('--permission-mode') + 1]).toBe(
            next === 'bypass' ? 'bypassPermissions' : 'auto',
          )
          const last = (await hostRecords(home, run.id)).filter((r) => r.t === 'start').at(-1)
          expect(last).toMatchObject({ v: hostProtocol, permissions: next })
          expect(last?.hostPid).not.toBe(legacy.pid)
        } finally {
          await writeFile(gate, '')
        }
      } finally {
        legacy.kill('SIGKILL')
      }
    },
  )

  test.each(['legacy', 'current'] as const)(
    'Stop cancels a %s restart during delayed shutdown',
    async (kind) => {
      let setup: { client: Client; task: Task; run: Run }
      if (kind === 'legacy') setup = await waitingLegacyRun()
      else {
        const client = await start()
        const [factory] = await client.ok<Factory[]>('GET', '/factories')
        await client.ok('PUT', `/factories/${factory?.id}/permissions`, {
          mode: 'bypass',
          confirmBypass: true,
        })
        const task = await startTask(client, [{ endTurn: true }])
        const run = await leadRun(client, task)
        await waitUntil(async () => (await client.getRun(run.id)).run.state === 'idle', 'idle Run')
        setup = { client, task, run }
      }
      const { client, task, run } = setup
      const before = (await hostRecords(home, run.id)).filter((r) => r.t === 'start')
      const gate = path.join(scratch, 'stop-during-shutdown')
      await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ stopWaitsFor: gate }))
      let restarted = false
      const restarting = client.call('POST', `/runs/${run.id}/restart`).finally(() => {
        restarted = true
      })
      await waitUntil(() => stat(`${gate}.waiting`).catch(() => undefined), 'shutdown started')
      const mtime = (await stat(`${gate}.waiting`, { bigint: true })).mtimeNs
      let stopped = false
      const stopping = client.call('POST', `/tasks/${task.id}/stop`).finally(() => {
        stopped = true
      })
      try {
        await waitUntil(
          async () => (await stat(`${gate}.waiting`, { bigint: true })).mtimeNs > mtime,
          'Stop reached old agent',
        )
        if (kind === 'current') process.kill(Number(before.at(-1)?.hostPid), 'SIGHUP')
        await writeFile(gate, '')
        await waitUntil(() => stopped && restarted, 'Stop and restart settled', 3_000)
        expect((await stopping).status).toBe(200)
        expect((await restarting).status).toBe(409)
        expect((await client.getRun(run.id)).run).toMatchObject({
          state: 'finished',
          ended: { how: 'stopped' },
        })
        expect((await hostRecords(home, run.id)).filter((r) => r.t === 'start')).toHaveLength(
          before.length,
        )
        for (const start of before) {
          const pid = start.agentPid
          if (typeof pid === 'number') expect(() => process.kill(pid, 0)).toThrow()
        }
      } finally {
        await writeFile(gate, '')
        await cleanupRequests(() => stopped && restarted)
      }
    },
  )

  test('Stop keeps consent protected while its host lookup is delayed', async () => {
    const client = await start()
    const [factory] = await client.ok<Factory[]>('GET', '/factories')
    const route = `/factories/${factory?.id}/permissions`
    const task = await startTask(client, [bash('echo waiting', 'Wait'), { endTurn: true }])
    const run = await leadRun(client, task)
    await waitUntil(
      async () => (await client.getRun(run.id)).run.state === 'waiting',
      'waiting Run',
    )
    await client.ok('PUT', route, { mode: 'bypass', confirmBypass: true })
    const gate = path.join(scratch, 'stop-consent')
    await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ stopWaitsFor: gate }))
    const restarting = client.call('POST', `/runs/${run.id}/restart`)
    await waitUntil(() => stat(`${gate}.waiting`).catch(() => undefined), 'restart shutdown')
    const pidFile = path.join(home, 'runs', run.id, 'host.pid')
    const pid = await readFile(pidFile)
    await rename(pidFile, `${pidFile}.saved`)
    execFileSync('mkfifo', [pidFile])
    const stopping = client.call('POST', `/tasks/${task.id}/stop`)
    const writer = await open(pidFile, 'w')
    try {
      expect((await restarting).status).toBe(409)
      expect((await client.call('PUT', route, { mode: 'auto' })).status).toBe(200)
      const starts = (await hostRecords(home, run.id)).filter((r) => r.t === 'start').length
      await writeFile(gate, '')
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect((await hostRecords(home, run.id)).filter((r) => r.t === 'start')).toHaveLength(starts)
      expect(starts).toBe(1)
      const original = (await hostRecords(home, run.id)).find((r) => r.t === 'start')
      expect(() => process.kill(Number(original?.agentPid), 0)).toThrow()
    } finally {
      await writer.writeFile(pid)
      await writer.close()
      await rm(pidFile)
      await rename(`${pidFile}.saved`, pidFile)
      await writeFile(gate, '')
      await stopping
    }
    expect((await client.getRun(run.id)).run).toMatchObject({
      state: 'finished',
      ended: { how: 'stopped' },
    })
  })

  test('Stop cancels automatic host replacement during delayed shutdown', async () => {
    const initial = await start('version: 1\n', true)
    const [factory] = await initial.ok<Factory[]>('GET', '/factories')
    await initial.ok('PUT', `/factories/${factory?.id}/permissions`, {
      mode: 'bypass',
      confirmBypass: true,
    })
    const task = await startTask(initial, [{ endTurn: true }])
    const run = await leadRun(initial, task)
    await waitUntil(async () => (await initial.getRun(run.id)).run.state === 'idle', 'idle Run')
    const gate = path.join(scratch, 'automatic-stop')
    await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ stopWaitsFor: gate }))
    daemonChild?.kill('SIGKILL')
    if (daemonChild) await once(daemonChild, 'exit')
    daemonChild = undefined
    daemon = await startDaemon({
      home,
      version: '9.9.9',
      claudeBin: stubClaudePath,
      codexBin: stubCodexPath,
      oldestHost: hostProtocol + 1,
    })
    const client = api(daemon.port, { appKey: daemon.appToken })
    await waitUntil(() => stat(`${gate}.waiting`).catch(() => undefined), 'automatic shutdown')
    const mtime = (await stat(`${gate}.waiting`, { bigint: true })).mtimeNs
    let stopped = false
    const stopping = client.call('POST', `/tasks/${task.id}/stop`).finally(() => {
      stopped = true
    })
    try {
      await waitUntil(
        async () => (await stat(`${gate}.waiting`, { bigint: true })).mtimeNs > mtime,
        'Stop reached automatic replacement',
      )
      await writeFile(gate, '')
      await waitUntil(() => stopped, 'Stop settled', 3_000)
      expect((await stopping).status).toBe(200)
      expect((await client.getRun(run.id)).run).toMatchObject({
        state: 'finished',
        ended: { how: 'stopped' },
      })
      expect((await hostRecords(home, run.id)).filter((r) => r.t === 'start')).toHaveLength(1)
    } finally {
      await writeFile(gate, '')
      await cleanupRequests(() => stopped)
    }
  })

  test('Stop cancels a replacement queued behind another Run’s permission lease', async () => {
    const { client, route, task, run } = await waitingLegacyRun()
    const holderTask = await startTask(client, [{ endTurn: true }])
    const holder = await leadRun(client, holderTask)
    await waitUntil(
      async () => (await client.getRun(holder.id)).run.state === 'idle',
      'lease holder idle',
    )
    const gate = path.join(scratch, 'held-lease')
    await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ stopWaitsFor: gate }))
    let holderDone = false
    const holding = client.call('POST', `/runs/${holder.id}/restart`).finally(() => {
      holderDone = true
    })
    await waitUntil(() => stat(`${gate}.waiting`).catch(() => undefined), 'lease held')
    await writeFile(path.join(home, 'stub-claude.json'), '{}')
    let restarted = false
    const restarting = client.call('POST', `/runs/${run.id}/restart`).finally(() => {
      restarted = true
    })
    await waitUntil(
      async () => (await hostRecords(home, run.id)).some((r) => r.t === 'exit'),
      'old host exited',
    )
    let stopped = false
    const stopping = client.call('POST', `/tasks/${task.id}/stop`).finally(() => {
      stopped = true
    })
    try {
      await waitUntil(() => stopped && restarted, 'canceled requests settled without lease', 3_000)
      expect(holderDone).toBe(false)
      expect((await stopping).status).toBe(200)
      expect((await restarting).status).toBe(409)
      await writeFile(gate, '')
      await holding
      await client.ok('PUT', route, { mode: 'auto' })
      expect((await hostRecords(home, run.id)).filter((r) => r.t === 'start')).toHaveLength(2)
      expect((await client.getRun(run.id)).run).toMatchObject({
        state: 'finished',
        ended: { how: 'stopped' },
      })
    } finally {
      await writeFile(gate, '')
      await cleanupRequests(() => stopped && restarted && holderDone)
    }
  })

  test('Stop cancels replacement preparation and prevents a later launch after I/O completes', async () => {
    const { client, route, task, run } = await waitingLegacyRun()
    const env = path.join(home, 'runs', run.id, 'env.json')
    const content = await readFile(env)
    await rename(env, `${env}.saved`)
    execFileSync('mkfifo', [env])
    let restarted = false
    const restarting = client.call('POST', `/runs/${run.id}/restart`).finally(() => {
      restarted = true
    })
    const writer = await open(env, 'w')
    let stopped = false
    const stopping = client.call('POST', `/tasks/${task.id}/stop`).finally(() => {
      stopped = true
    })
    try {
      await waitUntil(
        () => stopped && restarted,
        'canceled requests settled during preparation',
        3_000,
      )
      expect((await stopping).status).toBe(200)
      expect((await restarting).status).toBe(409)
    } finally {
      await writer.writeFile(content)
      await writer.close()
      await rm(env)
      await rename(`${env}.saved`, env)
      await cleanupRequests(() => stopped && restarted)
    }
    await client.ok('PUT', route, { mode: 'auto' })
    expect((await hostRecords(home, run.id)).filter((r) => r.t === 'start')).toHaveLength(2)
    expect((await client.getRun(run.id)).run).toMatchObject({
      state: 'finished',
      ended: { how: 'stopped' },
    })
  })

  test('failed restart preparation preserves the running agent’s recorded permissions', async () => {
    const client = await start()
    const [factory] = await client.ok<Factory[]>('GET', '/factories')
    const route = `/factories/${factory?.id}/permissions`
    await client.ok('PUT', route, { mode: 'bypass', confirmBypass: true })
    const task = await startTask(client, [{ endTurn: true }])
    const run = await leadRun(client, task)
    await waitUntil(async () => (await client.getRun(run.id)).run.state === 'idle', 'idle Run')
    const original = await readFile(path.join(run.cwd, 'stub-record.json'), 'utf8')
    const settings = path.join(home, 'runs', run.id, 'settings.json')
    await rename(settings, `${settings}.saved`)
    await mkdir(settings)
    try {
      await client.ok('PUT', route, { mode: 'auto' })
      expect((await client.call('POST', `/runs/${run.id}/restart`)).status).toBe(409)
      expect((await client.getRun(run.id)).run).toMatchObject({
        state: 'idle',
        permissions: 'bypass',
      })
      expect(await readFile(path.join(run.cwd, 'stub-record.json'), 'utf8')).toBe(original)
      const { pid } = JSON.parse(original) as { pid: number }
      expect(() => process.kill(pid, 0)).not.toThrow()
    } finally {
      await rm(settings, { recursive: true })
      await rename(`${settings}.saved`, settings)
    }
    const gate = path.join(scratch, 'accounting-shutdown')
    await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ stopWaitsFor: gate }))
    const restarting = client.ok('POST', `/runs/${run.id}/restart`)
    try {
      await waitUntil(
        () =>
          readFile(`${gate}.waiting`)
            .then(() => true)
            .catch(() => false),
        'shutdown gate',
      )
      expect((await client.getRun(run.id)).run.permissions).toBe('bypass')
    } finally {
      await writeFile(gate, '')
      await restarting
    }
    expect((await client.getRun(run.id)).run.permissions).toBe('auto')
    expect((await hostRecords(home, run.id)).filter((r) => r.t === 'start').at(-1)).toMatchObject({
      permissions: 'auto',
    })
  })

  test('recovery reconciles permission mode from a process started while the daemon was down', async () => {
    const client = await start('version: 1\n', true)
    const [factory] = await client.ok<Factory[]>('GET', '/factories')
    const route = `/factories/${factory?.id}/permissions`
    await client.ok('PUT', route, { mode: 'bypass', confirmBypass: true })
    const task = await startTask(client, [{ endTurn: true }])
    const run = await leadRun(client, task)
    await waitUntil(async () => (await client.getRun(run.id)).run.state === 'idle', 'idle Run')
    await client.ok('PUT', route, { mode: 'auto' })
    daemonChild?.kill('SIGKILL')
    if (daemonChild) await once(daemonChild, 'exit')
    daemonChild = undefined
    const file = path.join(home, 'runs', run.id, 'launch.json')
    const launch = JSON.parse(await readFile(file, 'utf8')) as { args: string[] }
    await writeFile(
      file,
      JSON.stringify({
        ...launch,
        args: launch.args.map((arg) => (arg === 'bypassPermissions' ? 'auto' : arg)),
        permissions: 'auto',
        launchId: 'prepared-auto-before-daemon-crash',
      }),
    )
    const starts = (await hostRecords(home, run.id)).filter((r) => r.t === 'start')
    process.kill(Number(starts.at(-1)?.hostPid), 'SIGHUP')
    await waitUntil(
      async () => (await hostRecords(home, run.id)).filter((r) => r.t === 'start').length === 2,
      'process started while daemon was down',
    )
    daemon = await startDaemon({
      home,
      version: '9.9.9',
      claudeBin: stubClaudePath,
      codexBin: stubCodexPath,
    })
    const reopened = api(daemon.port, { appKey: daemon.appToken })
    await waitUntil(
      async () => (await reopened.getRun(run.id)).run.permissions === 'auto',
      'actual mode recovered',
    )
    const record = JSON.parse(await readFile(path.join(run.cwd, 'stub-record.json'), 'utf8')) as {
      argv: string[]
    }
    expect(record.argv[record.argv.indexOf('--permission-mode') + 1]).toBe('auto')
  })

  test('a timed-out restart kills the old Bypass agent before releasing consent', async () => {
    const client = await start(undefined, false, { stopGraceMs: 4_000 })
    const [factory] = await client.ok<Factory[]>('GET', '/factories')
    const route = `/factories/${factory?.id}/permissions`
    await client.ok('PUT', route, { mode: 'bypass', confirmBypass: true })
    const task = await startTask(client, [{ endTurn: true }])
    const run = await leadRun(client, task)
    await waitUntil(async () => (await client.getRun(run.id)).run.state === 'idle', 'idle Run')
    const original = JSON.parse(await readFile(path.join(run.cwd, 'stub-record.json'), 'utf8')) as {
      pid: number
      argv: string[]
    }
    expect(original.argv[original.argv.indexOf('--permission-mode') + 1]).toBe('bypassPermissions')
    const alive = () => {
      try {
        process.kill(original.pid, 0)
        return true
      } catch {
        return false
      }
    }
    const gate = path.join(scratch, 'timeout-shutdown')
    await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ stopWaitsFor: gate }))
    const restarting = client.call('POST', `/runs/${run.id}/restart`)
    try {
      await waitUntil(
        () =>
          readFile(`${gate}.waiting`)
            .then(() => true)
            .catch(() => false),
        'shutdown gate',
      )
      await client.ok('PUT', route, { mode: 'auto' })
      expect((await restarting).status).toBeGreaterThanOrEqual(400)
      await waitUntil(() => !alive(), 'old agent terminated after restart timeout', 2_000)
      await client.ok('POST', `/tasks/${task.id}/stop`)
      expect(alive()).toBe(false)
    } finally {
      await writeFile(gate, '')
      await restarting
    }
  })

  test('old-host replacement reads consent after a delayed shutdown', async () => {
    const client = await start('version: 1\n', true)
    const [factory] = await client.ok<Factory[]>('GET', '/factories')
    const route = `/factories/${factory?.id}/permissions`
    await client.ok('PUT', route, { mode: 'bypass', confirmBypass: true })
    const task = await startTask(client, [{ endTurn: true }])
    const run = await leadRun(client, task)
    await waitUntil(async () => (await client.getRun(run.id)).run.state === 'idle', 'idle Run')
    const gate = path.join(scratch, 'old-host-shutdown')
    await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ stopWaitsFor: gate }))
    daemonChild?.kill('SIGKILL')
    if (daemonChild) await once(daemonChild, 'exit')
    daemonChild = undefined
    daemon = await startDaemon({
      home,
      version: '9.9.9',
      claudeBin: stubClaudePath,
      codexBin: stubCodexPath,
      oldestHost: hostProtocol + 1,
    })
    const reopened = api(daemon.port, { appKey: daemon.appToken })
    await waitUntil(
      () =>
        readFile(`${gate}.waiting`)
          .then(() => true)
          .catch(() => false),
      'old host shutdown',
    )
    expect((await reopened.call('PUT', route, { mode: 'auto' })).status).toBe(200)
    await writeFile(gate, '')
    await waitUntil(
      async () => (await hostRecords(home, run.id)).filter((r) => r.t === 'start').length >= 2,
      'replacement',
    )
    const record = await waitUntil(
      () =>
        readFile(path.join(run.cwd, 'stub-record.json'), 'utf8').then((s) => {
          const record = JSON.parse(s) as { argv: string[] }
          return record.argv.includes('--resume') ? record : undefined
        }),
      'replacement arguments',
    )
    expect(record.argv[record.argv.indexOf('--permission-mode') + 1]).toBe('auto')
    await waitUntil(
      async () => (await reopened.getRun(run.id)).run.permissions === 'auto',
      'replacement process mode recorded',
    )
  })

  test('a daemon restart invalidates a pending Bypass launch before revocation is saved', async () => {
    const client = await start('version: 1\n', true)
    const [factory] = await client.ok<Factory[]>('GET', '/factories')
    const route = `/factories/${factory?.id}/permissions`
    await client.ok('PUT', route, { mode: 'bypass', confirmBypass: true })
    const task = await startTask(client, [{ endTurn: true }])
    const run = await leadRun(client, task)
    await waitUntil(async () => (await client.getRun(run.id)).run.state === 'idle', 'idle Run')
    const gate = path.join(scratch, 'crash-shutdown')
    await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ stopWaitsFor: gate }))
    const restarting = client.call('POST', `/runs/${run.id}/restart`).catch(() => undefined)
    await waitUntil(
      () =>
        readFile(`${gate}.waiting`)
          .then(() => true)
          .catch(() => false),
      'shutdown gate',
    )
    daemonChild?.kill('SIGKILL')
    if (daemonChild) await once(daemonChild, 'exit')
    daemonChild = undefined
    await restarting
    daemon = await startDaemon({
      home,
      version: '9.9.9',
      claudeBin: stubClaudePath,
      codexBin: stubCodexPath,
    })
    const reopened = api(daemon.port, { appKey: daemon.appToken })
    expect((await reopened.call('PUT', route, { mode: 'auto' })).status).toBe(200)
    await writeFile(gate, '')
    await waitUntil(
      async () => (await hostRecords(home, run.id)).filter((r) => r.t === 'start').length >= 2,
      'recovery',
    )
    const starts = await waitUntil(
      () =>
        readFile(path.join(run.cwd, 'stub-starts.jsonl'), 'utf8').then((s) => {
          const records = s
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { argv: string[] })
          return records.length >= 2 ? records : undefined
        }),
      'recovered process arguments',
    )
    for (const record of starts.slice(1))
      expect(record.argv[record.argv.indexOf('--permission-mode') + 1]).toBe('auto')
    await waitUntil(
      async () => (await reopened.getRun(run.id)).run.permissions === 'auto',
      'replacement process mode recorded',
    )
  })

  test('daemon close invalidates pending launches without killing existing agents', async () => {
    const client = await start()
    const [factory] = await client.ok<Factory[]>('GET', '/factories')
    await client.ok('PUT', `/factories/${factory?.id}/permissions`, {
      mode: 'bypass',
      confirmBypass: true,
    })
    const task = await startTask(client, [{ endTurn: true }])
    const run = await leadRun(client, task)
    await waitUntil(async () => (await client.getRun(run.id)).run.state === 'idle', 'idle Run')
    const otherTask = await startTask(client, [{ endTurn: true }])
    const other = await leadRun(client, otherTask)
    await waitUntil(
      async () => (await client.getRun(other.id)).run.state === 'idle',
      'other idle Run',
    )
    const otherStart = (await hostRecords(home, other.id)).filter((r) => r.t === 'start').at(-1)
    const gate = path.join(scratch, 'close-shutdown')
    await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ stopWaitsFor: gate }))
    const restarting = client.call('POST', `/runs/${run.id}/restart`).catch(() => undefined)
    await waitUntil(() => stat(`${gate}.waiting`).catch(() => undefined), 'restart shutdown')
    try {
      await daemon?.stop()
      daemon = undefined
      await restarting
      expect(() => process.kill(Number(otherStart?.agentPid), 0)).not.toThrow()
      await writeFile(gate, '')
      await waitUntil(
        () => !isLockHeld(path.join(home, 'runs', run.id, 'host.lock')),
        'pending host exited',
      )
      expect((await hostRecords(home, run.id)).filter((r) => r.t === 'start')).toHaveLength(1)
      expect(() => process.kill(Number(otherStart?.agentPid), 0)).not.toThrow()
    } finally {
      await writeFile(gate, '')
    }
  })

  test('local consent persists on daemon restart and is removed with the Factory', async () => {
    const client = await start()
    const [factory] = await client.ok<Factory[]>('GET', '/factories')
    const id = factory?.id ?? ''
    await client.ok('PUT', `/factories/${id}/permissions`, { mode: 'bypass', confirmBypass: true })
    await daemon?.stop()
    daemon = await startDaemon({
      home,
      version: '9.9.9',
      claudeBin: stubClaudePath,
      codexBin: stubCodexPath,
    })
    const reopened = api(daemon.port, { appKey: daemon.appToken })
    expect((await reopened.call('GET', `/factories/${id}/settings`)).body).toMatchObject({
      permissions: 'bypass',
    })
    expect((await reopened.call('POST', `/factories/${id}/remove`, { key: 'NB' })).status).toBe(200)
    expect((await reopened.call('GET', '/settings')).body).toMatchObject({ factoryPermissions: {} })
  })
})
