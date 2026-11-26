import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { DaemonClient, readDaemonInfo, tedPaths } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

const cliPath = fileURLToPath(new URL('../src/main.ts', import.meta.url))

import { shellQuote } from '../../daemon/src/node-entry.ts'
import { loadRunTokens } from '../../daemon/src/run-token.ts'
import { stubKeyringFile } from '../../daemon/test/fixtures/stub-keyring.ts'
import { startStubLinear } from '../../daemon/test/fixtures/stub-linear.ts'
import {
  appClient,
  commitToOrigin,
  isAlive,
  makeOriginRepo,
  spawnDaemonProcess,
  stopDaemonIn,
  stubCodexPath,
  testAppToken,
  waitForExit,
  waitUntil,
} from '../../daemon/test/helpers.ts'

const stubClaudePath = fileURLToPath(
  new URL('../../daemon/test/fixtures/stub-claude.ts', import.meta.url),
)
const run = promisify(execFile)

let home: string

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-cli-'))
})

afterEach(async () => {
  await stopDaemonIn(home)
  await rm(home, { recursive: true, force: true })
})

function ted(args: string[], idleExitMs = 30_000, extraEnv: NodeJS.ProcessEnv = {}) {
  return run(process.execPath, [cliPath, ...args], {
    env: {
      ...process.env,
      ...extraEnv,
      TED_HOME: home,
      TED_IDLE_EXIT_MS: String(idleExitMs),
      TED_CLAUDE_BIN: stubClaudePath,
      TED_CODEX_BIN: stubCodexPath,
    },
    cwd: home,
  })
}

async function client(): Promise<DaemonClient> {
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('no daemon.json')
  return new DaemonClient(info)
}

async function startAsApp(): Promise<DaemonClient> {
  spawnDaemonProcess([], {
    ...process.env,
    TED_HOME: home,
    TED_CLAUDE_BIN: stubClaudePath,
    TED_CODEX_BIN: stubCodexPath,
  })
  const info = await waitUntil(() => readDaemonInfo(home), 'daemon.json')
  return appClient(info, testAppToken)
}

async function startDevRun(prompt: string, agent?: 'codex'): Promise<string> {
  const app = await startAsApp()
  return (await app.startDevRun({ prompt, cwd: home, ...(agent && { agent }) })).id
}

async function daemonPid(): Promise<number> {
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('no daemon.json')
  return info.pid
}

describe('ted task', () => {
  describe('create --source with a Linear URL', () => {
    const key = 'lin_api_abcdefghijklmnopqrstuvwxyz0123456789ABCD'
    const url = 'https://linear.app/kriyadesign/issue/NOTE-212/search-ignores-accents'

    test('with a key, the title and Priority come from Linear', async () => {
      const linear = await startStubLinear({
        [key]: {
          name: 'Nabha',
          workspace: { name: 'Kriya Design', urlKey: 'kriyadesign' },
          issues: [{ identifier: 'NOTE-212', title: 'Search ignores accents', priority: 1 }],
        },
      })
      try {
        await writeFile(stubKeyringFile(home), JSON.stringify({ secret: key }))

        const created = await ted(['task', 'create', '--source', url], 30_000, {
          TED_LINEAR_API: linear.url,
        })

        expect(created.stdout.trim()).toBe('Created DEV-1  Search ignores accents')
        const [task] = await (await client()).listTasks()
        expect(task).toMatchObject({ priority: 'urgent', source: { url } })
      } finally {
        await linear.close()
      }
    })

    test('without a key, it says so and creates the Task with the link only', async () => {
      const created = await ted(['task', 'create', '--source', url])

      expect(created.stdout.trim()).toBe(`Created DEV-1  ${url}`)
      expect(created.stderr.trim()).toBe(
        'No Linear API key, so the Task was created with the link only. Add one in Settings → Integrations.',
      )
      const [task] = await (await client()).listTasks()
      expect(task?.source).toEqual({ url })
    })

    test('a fetch that fails says why and still creates the Task', async () => {
      await writeFile(stubKeyringFile(home), JSON.stringify({ secret: key }))

      const created = await ted(['task', 'create', '--source', url, 'Accents'])

      expect(created.stdout.trim()).toBe('Created DEV-1  Accents')
      expect(created.stderr.trim()).toMatch(
        /^Couldn’t fetch from Linear: couldn’t reach Linear .*The Task will be created with the link only\.$/,
      )
    })
  })

  test('create starts the daemon when it is not running, list shows the Task, and Tasks are still there after the daemon restarts or is killed and leaves daemon.json behind', async () => {
    expect(await readDaemonInfo(home)).toBeUndefined()

    const created = await ted(['task', 'create', 'Fix login'])
    expect(created.stdout.trim()).toBe('Created DEV-1  Fix login')
    expect(isAlive(await daemonPid())).toBe(true)

    const listed = await ted(['task', 'list'])
    expect(listed.stdout.trim()).toBe('DEV-1  Backlog  Fix login')

    await ted(['task', 'create', 'Add dark mode'])
    const firstPid = await daemonPid()
    process.kill(firstPid, 'SIGTERM')
    await waitForExit(firstPid)

    const afterRestart = await ted(['task', 'list'])

    const secondPid = await daemonPid()
    expect(secondPid).not.toBe(firstPid)
    expect(afterRestart.stdout.trim().split('\n')).toEqual([
      'DEV-1  Backlog  Fix login',
      'DEV-2  Backlog  Add dark mode',
    ])

    process.kill(secondPid, 'SIGKILL')
    await waitForExit(secondPid)
    expect(await readDaemonInfo(home)).toMatchObject({ pid: secondPid })

    const afterKill = await ted(['task', 'list'])

    expect(afterKill.stdout.trim().split('\n')).toEqual([
      'DEV-1  Backlog  Fix login',
      'DEV-2  Backlog  Add dark mode',
    ])
  })

  test('a daemon that ted started exits once idle', async () => {
    await ted(['task', 'list'], 1_000)
    const pid = await daemonPid()

    await waitForExit(pid, 5_000)

    expect(await readDaemonInfo(home)).toBeUndefined()
  })

  test('lead sets the Task Lead’s agent, model and effort, and checks them', async () => {
    await ted(['task', 'create', 'Fix login'])

    const set = await ted([
      'task',
      'lead',
      'DEV-1',
      'codex',
      '--model',
      'gpt-6-mini',
      '--effort',
      'low',
    ])
    expect(set.stdout.trim()).toBe('DEV-1’s Task Lead is codex · gpt-6-mini · low')
    const plain = await ted(['task', 'lead', 'DEV-1', 'claude'])
    expect(plain.stdout.trim()).toBe('DEV-1’s Task Lead is claude · default model · default effort')

    await expect(ted(['task', 'lead', 'DEV-1', '--default-model'])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('isn’t waiting on its model'),
    })
  })

  test('lead keeps the stage, fixed and default baselines across configured and unconfigured Stages', async () => {
    const originDir = path.join(home, 'origin')
    const origin = await makeOriginRepo(originDir)
    await commitToOrigin(originDir, {
      '.ted/workflow.yaml':
        'version: 1\norder: [intake, work, merge]\nlead: { agent: claude, effort: low }\nstages:\n  intake: { effort: high }\n',
    })
    await writeFile(
      path.join(home, 'stub-claude.json'),
      JSON.stringify({ resumeSteps: [{ endTurn: true }] }),
    )
    const app = await startAsApp()
    await app.addFactory({ repo: origin, key: 'NB' })
    const started = []
    for (const mode of ['stage', 'fixed', 'default'] as const) {
      const go = path.join(home, `advance-${mode}`)
      const task = await app.createTask({
        factory: 'NB',
        title: JSON.stringify({
          steps: [
            { everyMessage: [{ endTurn: true }] },
            { waitFor: go },
            { run: ['ted', 'outcome', 'advance'] },
            { endTurn: true },
          ],
        }),
      })
      await ted(['task', 'lead', task.displayId, 'claude', '--effort', 'medium'])
      if (mode === 'stage') await ted(['task', 'lead', task.id, 'claude', '--stage-effort'])
      else if (mode === 'default') await ted(['task', 'lead', task.displayId, 'claude'])
      const baseline = mode === 'default' ? undefined : 'medium'
      const chosen = (await app.listTasks()).find((entry) => entry.id === task.id)?.lead
      expect(chosen, mode).toEqual({
        agent: 'claude',
        ...(baseline !== undefined && { effort: baseline }),
        ...(mode === 'stage' && { effortMode: 'stage' }),
      })
      await ted(['task', 'start', task.displayId])
      started.push({ mode, go, task, baseline })
    }
    for (const { mode, go, task, baseline } of started) {
      const initial = await waitUntil(async () => {
        const current = (await app.listTasks()).find((entry) => entry.id === task.id)
        if (!current?.leadRunId) return undefined
        const { run } = await app.getRun(current.leadRunId)
        return run.state === 'working' && run.sessionId ? run : undefined
      }, `the Intake session (${mode})`)
      expect(initial.effort, mode).toBe(mode === 'stage' ? 'high' : baseline)
      await writeFile(go, '')
      const next = await waitUntil(async () => {
        const current = (await app.listTasks()).find((entry) => entry.id === task.id)
        if (current?.stage !== 'work' || !current.leadRunId) return undefined
        const { run } = await app.getRun(current.leadRunId)
        return run.state === 'idle' && run.effort === baseline ? run : undefined
      }, `the unconfigured Work Stage with its saved baseline (${mode})`)
      expect(next.id, mode).toBe(initial.id)
      expect(next.sessionId, mode).toBe(initial.sessionId)
    }
  }, 120_000)

  test('list says so when there are no Tasks', async () => {
    const listed = await ted(['task', 'list'])
    expect(listed.stdout.trim()).toBe('No Tasks yet.')
  })

  test('an unknown command prints usage and fails', async () => {
    await expect(ted(['nonsense'])).rejects.toMatchObject({ code: 2 })
  })
})

describe('ted dev slow', () => {
  test('prints the daemon’s slow requests and stalls for the last minute and hour', async () => {
    const { stdout } = await ted(['dev', 'slow'])

    const lines = stdout.trim().split('\n')
    expect(lines[0]).toMatch(
      /^Measured since \d{4}-\d\d-\d\dT[\d:.]+Z\. A request is slow over 100 ms; the event loop is blocked over 200 ms\.$/,
    )
    expect(lines).toContain('Last minute')
    expect(lines).toContain('Last hour')
    expect(lines.filter((line) => line.startsWith('  Event loop: '))).toHaveLength(2)
    expect(lines.filter((line) => line.startsWith('  Requests: '))).toHaveLength(2)
  })
})

describe('ted dev run', () => {
  async function shownWhenFinished(id: string): Promise<string> {
    const daemon = await client()
    await waitUntil(
      async () => (await daemon.getRun(id)).run.state === 'finished',
      `Run ${id} to finish`,
    )
    return (await ted(['dev', 'run', 'show', id])).stdout
  }

  test('show prints a Run’s state and Conversation', async () => {
    const prompt = JSON.stringify({
      steps: [{ say: 'hi from the stub' }, { endTurn: true }, { exit: 0 }],
    })

    const id = await startDevRun(prompt)

    const shown = await shownWhenFinished(id)
    const lines = shown.trim().split('\n')
    expect(lines[0]).toBe(`Run ${id.slice(0, 6)}  claude  finished`)
    expect(lines[1]).toMatch(/^Session [0-9a-f-]{36}$/)
    expect(lines).toContain('assistant: hi from the stub')
    expect(lines).toContain('system hook_started Stop')
  })

  test('show prints a Codex Run’s thread and messages', async () => {
    const prompt = JSON.stringify({
      steps: [{ say: 'hi from Codex' }, { endTurn: true }, { exit: 0 }],
    })

    const id = await startDevRun(prompt, 'codex')

    const shown = await shownWhenFinished(id)
    const lines = shown.trim().split('\n')
    expect(lines[0]).toBe(`Run ${id.slice(0, 6)}  codex  finished`)
    expect(lines[1]).toMatch(/^Session 0199a000-/)
    expect(lines).toContain('item/completed: hi from Codex')
    expect(lines).toContain('turn/completed')
  })

  test('show strips terminal control characters from agent output', async () => {
    const hostile = 'a\u001b]0;pwned\u0007b\u001b[31mc\u009bd'
    const prompt = JSON.stringify({ steps: [{ say: hostile }, { endTurn: true }, { exit: 0 }] })
    const id = await startDevRun(prompt)

    const shown = await shownWhenFinished(id)
    expect(shown).toContain('assistant: abcd')
    const controls = [...shown].filter((c) => {
      const code = c.codePointAt(0) ?? 0
      return (code < 0x20 && c !== '\n') || (code >= 0x7f && code <= 0x9f)
    })
    expect(controls).toEqual([])
  })

  test('show refuses an unknown Run', async () => {
    await expect(ted(['dev', 'run', 'show', 'nope'])).rejects.toMatchObject({
      code: 1,
      stderr: 'ted: no such Run\n',
    })
  })
})

function tedWithInput(args: string[], input: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      process.execPath,
      [cliPath, ...args],
      {
        env: {
          ...process.env,
          TED_HOME: home,
          TED_IDLE_EXIT_MS: '30000',
          TED_CLAUDE_BIN: stubClaudePath,
        },
        cwd: home,
      },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as number) : 0, stdout, stderr }),
    )
    child.stdin?.end(input)
  })
}

describe('ted backup', () => {
  test('restore asks to stop running Runs, saves current data, and restores', async () => {
    const prompt = JSON.stringify({ steps: [{ waitFor: path.join(home, 'never') }] })
    await startDevRun(prompt)
    await ted(['task', 'create', 'After the backup'])
    const daily = (await ted(['backup', 'list'])).stdout.split(' ')[0] ?? ''

    const declined = await tedWithInput(['backup', 'restore', daily], 'n\n')
    expect(declined.code).toBe(1)
    expect(declined.stdout).toBe('Restoring stops 1 Run. Stop it and restore? [y/N] ')
    expect(declined.stderr).toBe('ted: nothing restored\n')
    expect((await ted(['task', 'list'])).stdout).toContain('After the backup')

    const accepted = await tedWithInput(['backup', 'restore', daily], 'y\n')
    expect(accepted.code).toBe(0)
    const lines = accepted.stdout.split('\n')
    expect(lines[0]).toBe('Restoring stops 1 Run. Stop it and restore? [y/N] Stopped 1 Run.')
    expect(lines[1]).toBe(`Restored ${daily}.`)
    expect(lines[2]).toMatch(
      /^Your data from before the restore is in backup before-restore-\d{8}-\d{6}\.$/,
    )
    expect((await ted(['task', 'list'])).stdout).toBe('No Tasks yet.\n')
  })

  test('list shows the daily backup taken when Ted starts, restore --yes doesn’t ask, and an unknown backup fails', async () => {
    await ted(['task', 'create', 'Fix login'])

    const listed = await ted(['backup', 'list'])

    expect(listed.stdout).toMatch(/^daily-\d{8} {2}daily {2}\d{1,2} \w{3} \d{4}, \d{2}:\d{2}\n$/)
    const daily = listed.stdout.split(' ')[0] ?? ''

    const restored = await ted(['backup', 'restore', daily, '--yes'])
    expect(restored.stdout.split('\n')[0]).toBe(`Restored ${daily}.`)

    await expect(ted(['backup', 'restore', 'daily-19990101'])).rejects.toMatchObject({
      stderr: 'ted: no backup daily-19990101\n',
    })
  })
})

describe('ted help', () => {
  test('lists the commands a Task Lead uses', async () => {
    const { stdout } = await ted(['help'])
    expect(stdout).toContain('ted comment')
    expect(stdout).toContain('ted outcome advance')
    expect(stdout).toContain('ted status')
    expect(stdout).toContain('ted help')
  })
})

describe('ted dev factory and ted task start', () => {
  test('adds a Factory, creates a Task in it, starts it, and the Task Lead takes it to Done', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await commitToOrigin(path.join(home, 'origin'), {
      '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
    })
    const steps = JSON.stringify({
      steps: [
        { run: ['ted', 'comment', 'On it'] },
        { everyMessage: [{ run: ['ted', 'outcome', 'advance'] }] },
        { run: ['ted', 'outcome', 'advance'] },
      ],
    })

    await (await startAsApp()).addFactory({ repo: origin, key: 'NB' })
    const created = await ted(['task', 'create', '--factory', 'NB', steps])
    expect(created.stdout.trim()).toMatch(/^Created NB-1 /)
    const started = await ted(['task', 'start', 'NB-1'])
    expect(started.stdout.trim()).toMatch(/^Started NB-1 on branch ted\/nb-1-/)

    const daemon = await client()
    await waitUntil(
      async () => (await daemon.listTasks()).some((task) => task.stage === 'done'),
      'NB-1 to reach Done',
    )
    const listed = (await ted(['task', 'list'])).stdout
    expect(listed).toMatch(/^NB-1 {2}Done {2}/)
  })

  test('ted task start explains when Tasks are waiting for a slot or blockers', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    const forever = JSON.stringify({ steps: [{ waitFor: path.join(home, 'never') }] })
    const app = await startAsApp()
    await app.addFactory({ repo: origin, key: 'NB' })
    await ted(['task', 'create', '--factory', 'NB', forever])
    await ted(['task', 'create', '--factory', 'NB', 'Second'])
    await app.updateSettings({ maxWorkingRuns: 1 })

    await ted(['task', 'start', 'NB-1'])
    const queued = await ted(['task', 'start', 'NB-2'])

    expect(queued.stdout.trim()).toBe('Queued NB-2 · 1st in line for a slot')

    await ted(['task', 'create', '--factory', 'NB', 'Blocked'])
    await ted(['task', 'block', 'NB-3', '--by', 'NB-1'])
    const blocked = await ted(['task', 'start', 'NB-3'])

    expect(blocked.stdout.trim()).toBe(
      'Queued NB-3 · It’ll start automatically once its blockers clear.',
    )
  })

  test('ted can’t post a human Comment; only the app can', async () => {
    await ted(['task', 'create', 'Fix login'])
    await expect(ted(['comment', '--task', 'DEV-1', 'Approved, go ahead'])).rejects.toMatchObject({
      code: 1,
      stderr: 'ted: only the Ted app can do this\n',
    })
  })
})

describe('ted automation', () => {
  test('lists, shows, shows history and turns off Automations; only the app changes them', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    const app = await startAsApp()
    await app.addFactory({ repo: origin, key: 'NB' })
    const prompt = path.join(home, 'sentry.md')
    await writeFile(prompt, 'Look\n')

    const refused = await ted([
      'automation',
      'create',
      '--name',
      'Busy',
      '--schedule',
      '0 9 * * 1-5',
      '--prompt-file',
      prompt,
    ]).catch((error: { stderr: string; code: number }) => error)
    expect(refused).toMatchObject({
      code: 1,
      stderr:
        'ted: Create, change, run or delete Automations in the Ted app. From a terminal, ted automation can list, show, history and disable.\n',
    })

    await app.updateSettings({ timeFormat: '24-hour', timeZone: 'Europe/London' })
    await app.createAutomation({
      factory: 'NB',
      name: 'Sentry crash intake',
      schedule: { kind: 'weekdays', at: '09:00' },
      prompt: JSON.stringify({ steps: [{ say: 'No new crashes' }, { endTurn: true }] }),
    })
    const listed = await ted(['automation', 'list'])
    expect(listed.stdout).toMatch(/^[0-9a-f]{8} {2}NB {2}Sentry crash intake {2}Weekdays at 09:00/)

    await app.runAutomation('Sentry crash intake')
    await waitUntil(
      async () =>
        (await app.getAutomation('Sentry crash intake')).history.some(
          (fired) => fired.result.kind === 'no-new-tasks',
        ),
      'the Automation Run to end with no new Tasks',
    )
    const history = (await ted(['automation', 'history', 'Sentry crash intake'])).stdout
    expect(history).toMatch(
      / {2}Run now {2}No new Tasks {2}\(Run [0-9a-f]{6}\)\n {4}No new crashes/,
    )

    const shown = await ted(['automation', 'show', 'Sentry crash intake', '--factory', 'NB'])
    expect(shown.stdout).toContain('Schedule: Weekdays at 09:00 · Europe/London')
    expect(shown.stdout).toContain('Runs: 1 · Tasks created: 0')

    const off = await ted(['automation', 'disable', 'Sentry crash intake'])
    expect(off.stdout).toBe('Sentry crash intake is off\n')
    for (const args of [['enable'], ['run'], ['delete']]) {
      const denied = await ted(['automation', ...args, 'Sentry crash intake']).catch(
        (error: { code: number }) => error,
      )
      expect(denied).toMatchObject({ code: 1 })
    }
    expect((await ted(['automation', 'list'])).stdout).toContain('Off')
  })

  test('the template catalog carries release and unattended architecture review rules', async () => {
    await ted(['task', 'list'])
    const templates = await (await client()).automationTemplates()
    expect(templates.map((t) => t.name)).toEqual([
      'Pull new Linear issues assigned to me',
      'Import my Linear work',
      'Import my Asana work',
      'Turn new Sentry issues into Tasks',
      'Daily GitHub issue triage',
      'Import GitHub issues',
      'Review codebase architecture',
      'Audit the Apps',
    ])
    expect(templates.find((t) => t.id === 'linear-intake')?.prompt).toContain('ted linear intake')
    const sentry = templates.find((t) => t.id === 'sentry')?.prompt ?? ''
    expect(sentry).toContain('events from a release that contains that commit')
    expect(sentry).toContain('--sentry-id')
    const architecture = templates.find((t) => t.id === 'architecture')
    expect(architecture?.schedule).toEqual({ kind: 'weekly', days: ['mon'], at: '09:00' })
    for (const instruction of [
      'GLOSSARY.md',
      'ADRs',
      'deletion test',
      'GitHub',
      'default branch',
      'up to three',
      'before/after',
      'Do not pass `--start`',
      'query strings or fragments',
      'Do not use `--follow-up`',
      'Do not clone',
    ]) {
      expect(architecture?.prompt).toContain(instruction)
    }
  })
})

describe('ted open', () => {
  async function fakeApp() {
    const launched = path.join(home, 'launched.json')
    const app = path.join(home, 'Ted app')
    await writeFile(
      app,
      `#!/bin/sh\nprintf '{"args":"%s","runAsNode":"%s"}' "$*" "$ELECTRON_RUN_AS_NODE" > '${launched}'\n`,
      { mode: 0o755 },
    )
    const env = { TED_APP_EXECUTABLE: app, ELECTRON_RUN_AS_NODE: '1' }
    const read = () =>
      readFile(launched, 'utf8').then(
        (text) => JSON.parse(text) as unknown,
        () => undefined,
      )
    const forget = () => rm(launched, { force: true })
    return { env, read, forget }
  }

  test('with the app closed it says so and fails, or starts the app from an installed Ted; with the app open it asks the app to show its window instead of launching another copy', async () => {
    await ted(['task', 'list'])
    const app = await fakeApp()

    await expect(ted(['open'])).rejects.toMatchObject({
      code: 1,
      stderr: 'ted: Ted isn’t open. Open it from your app launcher.\n',
    })

    const starting = await ted(['open'], 30_000, app.env)

    expect(starting.stdout.trim()).toBe('Opening Ted')
    await expect.poll(app.read).toEqual({ args: '', runAsNode: '' })
    await app.forget()

    const seen: unknown[] = []
    const subscription = await (await client()).subscribe((event) => seen.push(event), {
      app: true,
    })
    try {
      const requests = () =>
        seen.filter((event) => (event as { type?: string }).type === 'open-requested')

      const plain = await ted(['open'])

      expect(plain.stdout.trim()).toBe('Opened Ted')
      await expect.poll(requests).toEqual([{ type: 'open-requested' }])

      const installed = await ted(['open'], 30_000, app.env)

      expect(installed.stdout.trim()).toBe('Opened Ted')
      await expect.poll(requests).toEqual([{ type: 'open-requested' }, { type: 'open-requested' }])
      expect(await app.read()).toBeUndefined()
    } finally {
      subscription.close()
    }
  })

  test('inside a Run, ted open is refused like every route closed to Runs', async () => {
    const runId = await startDevRun(JSON.stringify({ steps: [{ endTurn: true }] }))
    const runToken = (await loadRunTokens(tedPaths(home).runTokenKey)).issue(runId)

    await expect(
      run(process.execPath, [cliPath, 'open'], {
        env: { ...process.env, TED_HOME: home, TED_RUN_TOKEN: runToken },
      }),
    ).rejects.toMatchObject({ code: 1, stderr: 'ted: Not allowed from inside a Run\n' })
  })

  test('doesn’t start Ted’s background process just to open the app', async () => {
    await expect(ted(['open'])).rejects.toMatchObject({ code: 1 })

    expect(await readDaemonInfo(home)).toBeUndefined()
  })

  describe('from an installed Ted', () => {
    test('the bundled Linux command finds and launches its app through an installed symlink', async () => {
      const outer = path.join(home, 'Installed Ted')
      const resources = path.join(outer, 'resources')
      const bundledCommand = path.join(resources, 'bin', 'ted')
      const stagedCli = path.join(resources, 'app', 'packages', 'cli', 'src', 'main.js')
      const launched = path.join(home, 'launched.json')
      await mkdir(path.dirname(stagedCli), { recursive: true })
      await mkdir(path.dirname(bundledCommand), { recursive: true })
      await writeFile(stagedCli, `await import(${JSON.stringify(pathToFileURL(cliPath).href)})\n`)
      await writeFile(
        bundledCommand,
        await readFile(new URL('../../app/build/bin/ted', import.meta.url)),
        { mode: 0o755 },
      )
      await writeFile(
        path.join(outer, 'ted-app'),
        `#!/bin/sh\nif [ "$ELECTRON_RUN_AS_NODE" = 1 ]; then\n  exec ${shellQuote(process.execPath)} "$@"\nfi\nprintf '{"args":"%s","runAsNode":"%s"}' "$*" "$ELECTRON_RUN_AS_NODE" > ${shellQuote(launched)}\n`,
        { mode: 0o755 },
      )
      const bin = path.join(home, 'bin')
      await mkdir(bin)
      const installed = path.join(bin, 'ted')
      await symlink(path.relative(bin, bundledCommand), installed)

      const { stdout } = await run(installed, ['open'], {
        cwd: home,
        env: { ...process.env, TED_HOME: home, TED_APP_EXECUTABLE: '' },
      })

      expect(stdout.trim()).toBe('Opening Ted')
      await expect
        .poll(() => readFile(launched, 'utf8').then(JSON.parse, () => undefined))
        .toEqual({ args: '', runAsNode: '' })
      expect(await readDaemonInfo(home)).toBeUndefined()
    })

    test('starts the app when Ted isn’t running at all', async () => {
      const app = await fakeApp()

      const { stdout } = await ted(['open'], 30_000, app.env)

      expect(stdout.trim()).toBe('Opening Ted')
      await expect.poll(app.read).toEqual({ args: '', runAsNode: '' })
      expect(await readDaemonInfo(home)).toBeUndefined()
    })
  })
})

describe('ted status and ted doctor', () => {
  test('status prints the daemon and says there are no problems', async () => {
    const { stdout } = await ted(['status'])
    const pid = await daemonPid()

    expect(stdout).toContain(`Ted’s background process is running (pid ${pid})`)
    expect(stdout).toContain('No problems.')
  })

  test('status and doctor print every active banner, dismissed or not', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    const app = await startAsApp()
    await app.addFactory({ repo: origin, key: 'NB' })
    const [banner] = await app.listBanners()
    await app.dismissBanner(banner?.id ?? '')

    const status = (await ted(['status'])).stdout
    expect(status).toContain('1 problem:')
    expect(status).toMatch(
      /Warning {2}widgets {2}No checks set up · Validate relies on the agent alone {2}\[Open Configuration\] {2}\(dismissed until /,
    )

    const doctor = await ted(['doctor'])
    expect(doctor.stdout).toMatch(/[✓!] git \d/)
    expect(doctor.stdout).toMatch(/✓ gh 2\.89\.0 · .*stub-gh\.ts/)
    expect(doctor.stdout).toContain('✓ github.com · signed in as stub-user')
    expect(doctor.stdout).toContain('No checks set up · Validate relies on the agent alone')
  })

  test('doctor fails when a problem stops work', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await (await startAsApp()).addFactory({ repo: origin, key: 'NB' })
    await ted(['task', 'create', '--factory', 'NB', 'Anything'])
    await rm(path.join(home, 'repos'), { recursive: true, force: true })
    await rm(origin, { recursive: true, force: true })
    await expect(ted(['task', 'start', 'NB-1'])).rejects.toMatchObject({ code: 1 })

    await expect(ted(['doctor'])).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringMatching(/Stops work {2}widgets {2}Couldn’t clone acme\/widgets/),
    })
  })
})

describe('ted sandbox groups', () => {
  test('lists each group with what it opens, without a daemon', async () => {
    const { stdout } = await ted(['sandbox', 'groups'])

    expect(stdout).toContain('ios-xcode: ')
    expect(stdout).toContain('shared-tmp: ')
    expect(stdout).toContain('shared access on the user’s Mac')
    expect(stdout).toContain('  - Per-user temp folder: TemporaryItems/NSIRD_(xcodebuild|')
    expect(stdout).toContain('ManifestLoading: plain .dia files')
    expect(stdout).toContain('electron: ')
    expect(stdout).toContain('com.apple.coreservices.launchservicesd')
    expect(await readDaemonInfo(home)).toBeUndefined()
  })
})

describe('ted workflow check', () => {
  async function writeLayer(files: Record<string, string>) {
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(home, '.ted', file)), { recursive: true })
      await writeFile(path.join(home, '.ted', file), content)
    }
  }

  test('says so when .ted/ has no problems', async () => {
    await writeLayer({
      'workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
      'stages/work.md': '# Work\n\nBuild it.\n',
    })

    const { stdout } = await ted(['workflow', 'check'])

    expect(stdout.trim()).toBe('No problems in .ted')
  })

  test('reports file, line, column and message for each kind of error', async () => {
    await writeLayer({
      'workflow.yaml': [
        'version: 1',
        'order: [intake, security, work]',
        'stages:',
        '  Deploy: {}',
        '  work: { gate: maybe }',
        'repos:',
        '  - name: app',
        '  - name: app',
        '    remote: https://gitlab.com/kriya/lab.git',
        '',
      ].join('\n'),
      'stages/review.md': '\n',
    })

    const failure = await ted(['workflow', 'check']).then(
      () => undefined,
      (error: { code: number; stdout: string }) => error,
    )

    expect(failure?.code).toBe(1)
    expect(failure?.stdout.split('\n')).toEqual([
      '.ted/workflow.yaml:2:17: error: `security` has no Stage file; add stages/security.md',
      '.ted/workflow.yaml:4:3: error: unknown Stage `Deploy`; a custom Stage id is lowercase letters, digits and hyphens, up to 40 characters, and not a built-in id',
      '.ted/workflow.yaml:5:17: error: `stages.work.gate` must be true or false',
      '.ted/workflow.yaml:8:11: error: two repos are named `app`',
      '.ted/workflow.yaml:9:13: error: `remote` must be a GitHub repo',
      '.ted/stages/review.md:1:1: error: the Stage file is empty',
      '6 errors',
      '',
    ])
  })

  test('reports a bad agents.yaml and an Agent with no instructions file', async () => {
    await writeLayer({
      'agents.yaml': [
        'scout:',
        '  name: Scout',
        '  powers: [read_code, deploy]',
        'helper:',
        '  role: helps',
        '',
      ].join('\n'),
      'agents/helper.md': 'Help.\n',
    })

    const failure = await ted(['workflow', 'check']).then(
      () => undefined,
      (error: { code: number; stdout: string }) => error,
    )

    expect(failure?.code).toBe(1)
    expect(failure?.stdout.split('\n')).toEqual([
      '.ted/agents.yaml:1:1: error: `scout` has no instructions file; add agents/scout.md',
      '.ted/agents.yaml:3:23: error: unknown power `deploy` in `scout.powers`; the powers are ask, manage_tasks, manage_automations, propose_tasks, read_code, manage_agents, run_commands, run_outside',
      '.ted/agents.yaml:4:1: error: `helper` needs a `name`',
      '.ted/agents.yaml:5:3: error: unknown key `helper.role`; an Agent has name, description, agent, model, powers, commands, outside_commands, based_on',
      '4 errors',
      '',
    ])
    expect((await ted(['workflow', 'check', '.ted/agents/helper.md'])).stdout.trim()).toBe(
      'No problems in .ted/agents/helper.md',
    )
  })

  test('accepts the Validate round settings and rejects a P1-only round below 2', async () => {
    await writeLayer({
      'workflow.yaml': 'version: 1\nstages:\n  validate: { p1_only_from: 3, sub_agents: true }\n',
    })
    expect((await ted(['workflow', 'check'])).stdout.trim()).toBe('No problems in .ted')

    await writeLayer({
      'workflow.yaml':
        'version: 1\nstages:\n  validate:\n    p1_only_from: 1\n    sub_agents: sure\n',
    })
    const failure = await ted(['workflow', 'check']).then(
      () => undefined,
      (error: { code: number; stdout: string }) => error,
    )

    expect(failure?.code).toBe(1)
    expect(failure?.stdout.split('\n')).toEqual([
      '.ted/workflow.yaml:4:19: error: `stages.validate.p1_only_from` must be a round number, 2 or more, or false',
      '.ted/workflow.yaml:5:17: error: `stages.validate.sub_agents` must be true or false',
      '2 errors',
      '',
    ])
  })

  test('reports YAML that doesn’t parse, for a file named on the command line', async () => {
    await writeLayer({ 'workflow.yaml': 'order: [intake, work\n' })

    const failure = await ted(['workflow', 'check', '.ted/workflow.yaml']).then(
      () => undefined,
      (error: { code: number; stdout: string }) => error,
    )

    expect(failure?.code).toBe(1)
    expect(failure?.stdout).toMatch(/^\.ted\/workflow\.yaml:2:1: error: /)
  })

  test('warns about unknown keys without failing', async () => {
    await writeLayer({ 'workflow.yaml': 'version: 1\nshiny: true\n' })

    const { stdout } = await ted(['workflow', 'check', '.ted'])

    expect(stdout.split('\n')).toEqual([
      '.ted/workflow.yaml:2:1: warning: unknown key `shiny`',
      '1 warning',
      '',
    ])
  })
})

test('failure commands capture context and record, inspect, assess and request a decision on the own Task', async () => {
  const origin = await makeOriginRepo(path.join(home, 'origin'))
  await commitToOrigin(path.join(home, 'origin'), {
    '.ted/workflow.yaml': 'version: 1\norder: [intake, work, validate, review]\n',
  })
  const app = await startAsApp()
  await app.addFactory({ repo: origin, key: 'NB' })
  const created = await app.createTask({ factory: 'NB', title: '{"steps":[{"endTurn":true}]}' })
  await app.startTask(created.id)
  const current = await waitUntil(async () => {
    const task = (await app.listTasks()).find((t) => t.id === created.id)
    return task?.leadRunId && task.runs.some((r) => r.state === 'idle') ? task : undefined
  }, 'idle lead for failure CLI')
  const runId = current.leadRunId ?? ''
  const env = {
    TED_RUN: runId,
    TED_PLAN: '',
    TED_TASK: current.id,
    TED_RUN_CAPABILITY: (await loadRunTokens(tedPaths(home).runTokenKey)).issue(runId),
  }
  const invoke = async (args: string[]) =>
    JSON.parse((await ted(['failure', ...args], 30_000, env)).stdout)
  const context = await invoke(['context'])
  const input = path.join(home, 'failure.json')
  await writeFile(
    input,
    JSON.stringify({
      source: { kind: 'finding', runId: runId.slice(0, 6), finding: 'Extra test failure' },
      evidence: 'The fixture service is unavailable.',
      contextId: context.reference,
    }),
  )
  const failure = await invoke(['record', '--file', input])
  expect(failure.reference).toBe(failure.id.slice(0, 6))
  expect(failure.source.runId).toBe(runId)
  expect(failure.contextId).toBe(context.id)
  expect(failure.contextReference).toBe(context.reference)
  expect((await invoke(['show', failure.reference])).source.finding).toBe('Extra test failure')
  expect((await invoke(['show', failure.id])).id).toBe(failure.id)
  await writeFile(
    input,
    JSON.stringify({ evidence: 'A targeted reproduction fails before changed code runs.' }),
  )
  await invoke(['evidence', failure.reference, '--file', input])
  await writeFile(
    input,
    JSON.stringify({
      assessment: 'uncertain',
      recommendation: 'Close it as fixed once a targeted reproduction passes.',
      choice: 'fixed',
    }),
  )
  await invoke(['assess', failure.reference, '--file', input])
  expect((await invoke(['ask', failure.reference])).decisions).toHaveLength(1)
  expect(await invoke(['list'])).toHaveLength(1)
  expect((await invoke(['obligations'])).satisfied).toBe(false)
})

test('a lost browser mutation response is never replayed', async () => {
  let mutations = 0
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/tasks/NB-1/browser') {
      mutations++
      if (mutations === 1) req.socket.destroy()
      else {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ text: 'replayed' }))
      }
    } else if (req.url === '/tasks/NB-1/apps') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify([]))
    } else {
      res.statusCode = 404
      res.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  await writeFile(
    tedPaths(home).daemonInfo,
    JSON.stringify({ port: address.port, pid: process.pid, token: 'fixture', version: 'test' }),
  )
  try {
    await expect(
      ted(['browser', 'press', 'Enter'], 30_000, { TED_TASK: 'NB-1' }),
    ).rejects.toMatchObject({ code: 1 })
    expect(mutations).toBe(1)
  } finally {
    await rm(tedPaths(home).daemonInfo, { force: true })
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
