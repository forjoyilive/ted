import { execFileSync } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  Factory,
  FoundEditor,
  MachineSettings,
  ShellChange,
  ShellOutput,
  ShellWorkspace,
  Task,
  TaskShell,
} from '@ted/protocol'
import * as pty from 'node-pty'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  commitToOrigin,
  devRunToken,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-shell-'))
  vi.stubEnv('SHELL', '/bin/sh')
  vi.stubEnv('ENV', '')
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  vi.unstubAllEnvs()
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

type Client = Awaited<ReturnType<typeof startTed>>

async function start() {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    editors: { appDirs: [] },
  })
  return client(daemon)
}

function client(running: RunningDaemon) {
  const raw = api(running.port, { appKey: running.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await raw.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  return { ...raw, ok }
}

async function startTed() {
  const origin = await makeOriginRepo(scratch)
  await commitToOrigin(scratch, {
    '.ted/workflow.yaml': [
      'version: 1',
      'order: [intake, work, merge]',
      'repos:',
      '  - name: widgets',
      '    worktree:',
      '      env:',
      '        GREETING: hello',
      '',
    ].join('\n'),
  })
  const ted = await start()
  await ted.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  return ted
}

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })

async function startedTask(ted: Client): Promise<Task> {
  const never = steps({ waitFor: path.join(scratch, 'never') })
  const task = await ted.ok<Task>('POST', '/tasks', { title: never, factory: 'NB' })
  await ted.ok('POST', `/tasks/${task.id}/start`)
  return waitUntil(async () => {
    const found = (await ted.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)
    return found?.repos.some((r) => !r.removed) && found.leadRunId ? found : undefined
  }, 'the Task to have a worktree')
}

const shellRoute = (task: Task, rest = '') => `/tasks/${task.id}/repos/widgets/shell${rest}`

const size = { cols: 100, rows: 30 }

async function readUntil(
  ted: Client,
  task: Task,
  shell: { generation: number },
  check: (text: string) => boolean,
  id?: string,
): Promise<string> {
  let text = ''
  let from = 0
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const out = await ted.ok<ShellOutput>(
      'GET',
      shellRoute(
        task,
        `${id ? `/panes/${id}` : ''}/output?generation=${shell.generation}&from=${from}&waitMs=2000`,
      ),
    )
    text = out.reset ? out.data : text + out.data
    from = out.next
    if (check(text)) return text
  }
  throw new Error(`the shell never printed what was expected; it printed:\n${text}`)
}

const type = (ted: Client, task: Task, data: string) =>
  ted.ok('POST', shellRoute(task, '/input'), { data })

describe('Task shell', () => {
  test('opens the login shell in the worktree with worktree.env and TED_TASK but no TED_RUN, keeps one shell per repo across opens, and Restart starts a new one', async () => {
    const ted = await startTed()
    const task = await startedTask(ted)
    const repo = task.repos[0]
    if (!repo) throw new Error('no repo')

    const shell = await ted.ok<TaskShell>('POST', shellRoute(task), size)
    await type(
      ted,
      task,
      'echo "OUT""=$(pwd -P)|$TED_TASK|$(printenv TED_RUN || echo unset)|$GREETING|$(stty size)"\r',
    )
    const text = await readUntil(ted, task, shell, (t) => /OUT=.*\r?\n/.test(t))

    expect(shell).toMatchObject({ repo: 'widgets', path: repo.worktree, running: true })
    const [, line = ''] = /OUT=([^\r\n]*)/.exec(text) ?? []
    expect(line.split('|')).toEqual([
      await realpathOf(repo.worktree),
      task.displayId,
      'unset',
      'hello',
      '30 100',
    ])

    const first = shell
    await type(ted, task, 'MARK=kept; echo "[$MARK]"\r')
    await readUntil(ted, task, first, (t) => t.includes('[kept]'))

    const again = await ted.ok<TaskShell>('POST', shellRoute(task), size)
    await type(ted, task, 'echo "<$MARK>"\r')
    const kept = await readUntil(ted, task, again, (t) => t.includes('<kept>'))
    expect(again.generation).toBe(first.generation)
    expect(kept).toContain('[kept]')

    const fresh = await ted.ok<TaskShell>('POST', shellRoute(task, '/restart'), size)
    await type(ted, task, 'echo "{$MARK}"\r')
    const after = await readUntil(ted, task, fresh, (t) => t.includes('{}'))
    expect(fresh.generation).toBeGreaterThan(first.generation)
    expect(after).not.toContain('[kept]')
  })

  test('the shell outlives the app’s connection and Stop, and ends when the worktree is removed', async () => {
    const ted = await startTed()
    const task = await startedTask(ted)
    const shell = await ted.ok<TaskShell>('POST', shellRoute(task), size)
    await type(ted, task, 'echo "pid=$$"\r')
    const text = await readUntil(ted, task, shell, (t) => /pid=\d+/.test(t))
    const pid = Number(/pid=(\d+)/.exec(text)?.[1])

    await ted.ok('POST', `/tasks/${task.id}/stop`)
    const later = await ted.ok<ShellOutput>(
      'GET',
      shellRoute(task, `/output?generation=${shell.generation}&from=0`),
    )
    expect(later.running).toBe(true)
    expect(later.data).toContain(`pid=${pid}`)
    expect(await ted.ok('GET', '/activity')).toMatchObject({ shellsRunning: 1 })

    await ted.ok('POST', `/tasks/${task.id}/archive`)
    await waitUntil(async () => !alive(pid) || undefined, 'the shell to end')
    expect(await ted.ok('GET', '/activity')).toMatchObject({ shellsRunning: 0 })
    expect((await ted.call('POST', shellRoute(task, '/input'), { data: 'x' })).status).toBe(404)
  })
})

const workspaceRoute = (task: Task) => `${shellRoute(task)}s`
const changeWorkspace = (ted: Client, task: Task, change: ShellChange) =>
  ted.ok<ShellWorkspace>('POST', `${workspaceRoute(task)}/change`, change)
const paneRoute = (task: Task, id: string, rest = '') => shellRoute(task, `/panes/${id}${rest}`)

function firstShell(workspace: ShellWorkspace): TaskShell {
  const shell = workspace.shells[0]
  if (!shell) throw new Error('no shell')
  return shell
}

describe('Task shell panes', () => {
  test('a split refused for a missing worktree leaves the layout intact; a PTY launch failure preserves the workspace and activity, then splitting can retry', async () => {
    const ted = await startTed()
    const task = await startedTask(ted)
    const opened = await ted.ok<ShellWorkspace>('POST', workspaceRoute(task), size)
    const worktree = task.repos[0]?.worktree
    if (!worktree) throw new Error('no worktree')
    await rename(worktree, `${worktree}.away`)
    try {
      expect(
        (
          await ted.call('POST', `${workspaceRoute(task)}/change`, {
            kind: 'split',
            revision: opened.revision,
            shellId: firstShell(opened).id,
            direction: 'right',
            size,
          })
        ).status,
      ).toBe(409)
    } finally {
      await rename(`${worktree}.away`, worktree)
    }
    expect(await ted.ok('GET', workspaceRoute(task))).toEqual(opened)

    const activity = await ted.ok('GET', '/activity')
    const failure = vi.spyOn(pty, 'spawn').mockImplementationOnce(() => {
      throw new Error('fixture refuses PTY launch')
    })
    try {
      const result = await ted.call('POST', `${workspaceRoute(task)}/change`, {
        kind: 'split',
        revision: opened.revision,
        shellId: firstShell(opened).id,
        direction: 'right',
        size,
      })
      expect(failure).toHaveBeenCalledOnce()
      expect(result.status).toBeGreaterThanOrEqual(400)
      expect(await ted.ok('GET', workspaceRoute(task))).toEqual(opened)
      expect(await ted.ok('GET', '/activity')).toEqual(activity)
    } finally {
      failure.mockRestore()
    }
    const split = await changeWorkspace(ted, task, {
      kind: 'split',
      revision: opened.revision,
      shellId: firstShell(opened).id,
      direction: 'right',
      size,
    })
    expect(split.revision).toBe(opened.revision + 1)
    expect(split.shells).toHaveLength(2)
    expect(split.shells[0]).toEqual(firstShell(opened))
  })

  test('opening while the worktree is removed leaves no running panes', async () => {
    const ted = await startTed()
    const task = await startedTask(ted)
    await ted.ok('POST', `/tasks/${task.id}/stop`)
    const [open] = await Promise.all([
      ted.call('POST', workspaceRoute(task), size),
      ted.ok('POST', `/tasks/${task.id}/archive`),
    ])
    expect([200, 404, 409, 503]).toContain(open.status)
    await waitUntil(async () => {
      const state = await ted.call('GET', workspaceRoute(task))
      const activity = await ted.ok<{ shellsRunning: number }>('GET', '/activity')
      return (state.status === 404 && activity.shellsRunning === 0) || undefined
    }, 'removed worktree to have no live shells')
  })

  test('failed Close preserves the pane and revision and can be retried', async () => {
    const ted = await startTed()
    const task = await startedTask(ted)
    const opened = await ted.ok<ShellWorkspace>('POST', workspaceRoute(task), size)
    const first = firstShell(opened)
    await ted.ok('POST', paneRoute(task, first.id, '/input'), {
      data: 'printf "ROOT_PID=%s\\n" "$$"\r',
    })
    const text = await readUntil(ted, task, first, (t) => /ROOT_PID=\d+/.test(t), first.id)
    const root = Number(/ROOT_PID=(\d+)/.exec(text)?.[1])
    const kill = process.kill.bind(process)
    const failure = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === -root && signal === 'SIGSTOP')
        throw Object.assign(new Error('fixture refuses cleanup'), { code: 'EPERM' })
      return kill(pid, signal)
    })
    try {
      const refused = await ted.call('POST', `${workspaceRoute(task)}/change`, {
        kind: 'close',
        revision: opened.revision,
        shellId: first.id,
      })
      expect(refused.status).toBeGreaterThanOrEqual(400)
      expect(await ted.ok('GET', workspaceRoute(task))).toEqual(opened)
      expect(alive(root)).toBe(true)
    } finally {
      failure.mockRestore()
    }
    const closed = await changeWorkspace(ted, task, {
      kind: 'close',
      revision: opened.revision,
      shellId: first.id,
    })
    expect(closed.layout).toBeNull()
    expect(closed.revision).toBe(opened.revision + 1)
    expect(closed.shells).toEqual([])
    await waitUntil(async () => !alive(root) || undefined, 'the retried Close to end its shell')
  })

  test('shutdown retries a refused pane while cleaning the remaining panes', async () => {
    const ted = await startTed()
    const task = await startedTask(ted)
    const opened = await ted.ok<ShellWorkspace>('POST', workspaceRoute(task), size)
    const first = firstShell(opened)
    const split = await changeWorkspace(ted, task, {
      kind: 'split',
      revision: opened.revision,
      shellId: first.id,
      direction: 'right',
      size,
    })
    const roots: number[] = []
    for (const pane of split.shells) {
      await ted.ok('POST', paneRoute(task, pane.id, '/input'), {
        data: 'printf "ROOT_PID=%s\\n" "$$"\r',
      })
      const text = await readUntil(ted, task, pane, (t) => /ROOT_PID=\d+/.test(t), pane.id)
      roots.push(Number(/ROOT_PID=(\d+)/.exec(text)?.[1]))
    }
    const firstRoot = roots[0]
    const siblingRoot = roots[1]
    if (!firstRoot || !siblingRoot) throw new Error('no fixture shell PIDs')
    const kill = process.kill.bind(process)
    const failure = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === -firstRoot && signal === 'SIGSTOP')
        throw Object.assign(new Error('fixture refuses cleanup'), { code: 'EPERM' })
      return kill(pid, signal)
    })
    let finished = false
    let rejected: unknown
    const stopping = daemon?.stop().then(
      () => {
        finished = true
      },
      (error) => {
        rejected = error
        finished = true
      },
    )
    try {
      await waitUntil(
        async () => !alive(siblingRoot) || undefined,
        'the other pane to stop despite the refusal',
      )
      expect(alive(firstRoot)).toBe(true)
      expect(finished).toBe(false)
      failure.mockRestore()
      await stopping
      expect(rejected).toBeUndefined()
      expect(alive(firstRoot)).toBe(false)
    } finally {
      failure.mockRestore()
      await stopping
      daemon = undefined
      for (const pid of roots) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
    }
  })

  test('close, restart and reopen end a pane’s child jobs and keep its sibling; archive and shutdown end every pane’s child jobs (shell running or exited)', async () => {
    const ted = await startTed()
    const pids: number[] = []
    type Job = { child: number; root: number }
    const split = async (task: Task, ws: ShellWorkspace, from: TaskShell) => {
      const next = await changeWorkspace(ted, task, {
        kind: 'split',
        revision: ws.revision,
        shellId: from.id,
        direction: 'right',
        size,
      })
      const pane = next.shells.find((s) => !ws.shells.some((old) => old.id === s.id))
      if (!pane) throw new Error('no new pane')
      return { ws: next, pane }
    }
    const marked = async (task: Task, sibling: TaskShell) => {
      await ted.ok('POST', paneRoute(task, sibling.id, '/input'), {
        data: 'MARK=kept; echo "sibling=$MARK"\r',
      })
      await readUntil(ted, task, sibling, (t) => t.includes('sibling=kept'), sibling.id)
    }
    const jobIn = async (task: Task, pane: TaskShell, exited: boolean, name: string) => {
      await ted.ok('POST', paneRoute(task, pane.id, '/input'), {
        data: 'trap "" HUP; nohup sleep 120 >/dev/null 2>&1 & printf "CHILD_PID="; jobs -p; printf "ROOT_PID=%s\\n" "$$"\r',
      })
      const text = await readUntil(
        ted,
        task,
        pane,
        (t) => /CHILD_PID=\d+/.test(t) && /ROOT_PID=\d+/.test(t),
        pane.id,
      )
      const job: Job = {
        child: Number(/CHILD_PID=(\d+)/.exec(text)?.[1]),
        root: Number(/ROOT_PID=(\d+)/.exec(text)?.[1]),
      }
      pids.push(job.child, job.root)
      expect(alive(job.child), `${name}: the job runs`).toBe(true)
      if (exited) {
        await ted.ok('POST', paneRoute(task, pane.id, '/input'), { data: 'exit 7\r' })
        await waitUntil(async () => {
          const state = await ted.ok<ShellWorkspace>('GET', workspaceRoute(task))
          return state.shells.find((s) => s.id === pane.id)?.exitCode === 7 || undefined
        }, `${name}: the parent shell to exit before cleanup`)
        expect(alive(job.child), `${name}: the job outlives its exited shell`).toBe(true)
      }
      return job
    }
    const ended = (name: string, job: Job) =>
      waitUntil(
        async () => (!alive(job.root) && !alive(job.child)) || undefined,
        `${name}: the shell and its HUP-resistant job to exit`,
      )
    const caseName = (ending: string, exited: boolean) => `${ending} (shell exited: ${exited})`
    try {
      const task = await startedTask(ted)
      let ws = await ted.ok<ShellWorkspace>('POST', workspaceRoute(task), size)
      const first = firstShell(ws)
      const withSibling = await split(task, ws, first)
      ws = withSibling.ws
      const sibling = withSibling.pane
      await marked(task, sibling)
      const siblingKept = async (name: string) => {
        await ted.ok('POST', paneRoute(task, sibling.id, '/input'), {
          data: `echo "${name} still=$MARK"\r`,
        })
        await readUntil(ted, task, sibling, (t) => t.includes(`${name} still=kept`), sibling.id)
      }

      for (const ending of ['close', 'restart'] as const)
        for (const exited of [false, true]) {
          const name = caseName(ending, exited)
          const added = await split(task, ws, sibling)
          ws = added.ws
          const job = await jobIn(task, added.pane, exited, name)
          if (ending === 'close')
            ws = await changeWorkspace(ted, task, {
              kind: 'close',
              revision: ws.revision,
              shellId: added.pane.id,
            })
          else {
            const restarted = await ted.ok<TaskShell>(
              'POST',
              paneRoute(task, added.pane.id, '/restart'),
              size,
            )
            expect(restarted.generation, name).toBeGreaterThan(added.pane.generation)
          }
          await ended(name, job)
          await siblingKept(name)
        }

      const reopen = caseName('reopen', true)
      const reopenJob = await jobIn(task, first, true, reopen)
      const reopened = await ted.ok<TaskShell>('POST', shellRoute(task), size)
      expect(reopened.generation, reopen).toBeGreaterThan(first.generation)
      ws = await changeWorkspace(ted, task, {
        kind: 'close',
        revision: ws.revision,
        shellId: first.id,
      })
      await ended(reopen, reopenJob)
      await siblingKept(reopen)

      const archived: { name: string; job: Job }[] = []
      for (const exited of [false, true]) {
        const name = caseName('archive', exited)
        const added = await split(task, ws, sibling)
        ws = added.ws
        archived.push({ name, job: await jobIn(task, added.pane, exited, name) })
      }
      await ted.ok('POST', `/tasks/${task.id}/stop`)
      await ted.ok('POST', `/tasks/${task.id}/archive`)
      for (const { name, job } of archived) await ended(name, job)

      const other = await startedTask(ted)
      const otherOpened = await ted.ok<ShellWorkspace>('POST', workspaceRoute(other), size)
      const otherFirst = firstShell(otherOpened)
      const otherSibling = await split(other, otherOpened, otherFirst)
      await marked(other, otherSibling.pane)
      const otherPane = (await split(other, otherSibling.ws, otherFirst)).pane
      const stopped: { name: string; job: Job }[] = []
      for (const [pane, exited] of [
        [otherFirst, false],
        [otherPane, true],
      ] as const) {
        const name = caseName('shutdown', exited)
        stopped.push({ name, job: await jobIn(other, pane, exited, name) })
      }
      await daemon?.stop()
      daemon = undefined
      for (const { name, job } of stopped) await ended(name, job)
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
    }
  }, 90_000)

  test('close and restart leave a detached, reparented service outside terminal cleanup', async () => {
    const ted = await startTed()
    const task = await startedTask(ted)
    const opened = await ted.ok<ShellWorkspace>('POST', workspaceRoute(task), size)
    const first = firstShell(opened)
    const ws = await changeWorkspace(ted, task, {
      kind: 'split',
      revision: opened.revision,
      shellId: first.id,
      direction: 'right',
      size,
    })
    const sibling = ws.shells[1]
    if (!sibling) throw new Error('no sibling')
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    const pidFiles: string[] = []
    try {
      for (const ending of ['restart', 'close'] as const) {
        const pidFile = path.join(scratch, `detached-${ending}.pid`)
        pidFiles.push(pidFile)
        const childCode = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`
        const parentCode = `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { detached: true, stdio: 'ignore', env: { ...process.env } }); child.unref()`
        await ted.ok('POST', paneRoute(task, first.id, '/input'), {
          data: `${quote(process.execPath)} -e ${quote(parentCode)}\r`,
        })
        const child = await waitUntil(async () => {
          const value = await readFile(pidFile, 'utf8').catch(() => '')
          return Number(value) || undefined
        }, `${ending}: the detached service to report its PID`)
        await waitUntil(
          async () =>
            Number(
              execFileSync('/bin/ps', ['-p', String(child), '-o', 'ppid='], {
                encoding: 'utf8',
              }).trim(),
            ) === 1 || undefined,
          `${ending}: the detached service to be reparented before terminal cleanup`,
        )
        if (ending === 'close') {
          const closed = await changeWorkspace(ted, task, {
            kind: 'close',
            revision: ws.revision,
            shellId: first.id,
          })
          expect(
            closed.shells.map((shell) => shell.id),
            ending,
          ).toEqual([sibling.id])
        } else {
          const restarted = await ted.ok<TaskShell>(
            'POST',
            paneRoute(task, first.id, '/restart'),
            size,
          )
          expect(restarted.generation, ending).toBeGreaterThan(first.generation)
        }
        expect(alive(child), ending).toBe(true)
        await ted.ok('POST', paneRoute(task, sibling.id, '/input'), {
          data: `printf "SIBLING_OK_${ending}\\n"\r`,
        })
        await readUntil(
          ted,
          task,
          sibling,
          (text) => text.includes(`SIBLING_OK_${ending}\r\n`),
          sibling.id,
        )
      }
    } finally {
      for (const pidFile of pidFiles) {
        const fixturePid = Number(await readFile(pidFile, 'utf8').catch(() => '')) || undefined
        if (!fixturePid) continue
        try {
          process.kill(fixturePid, 'SIGKILL')
        } catch {}
        await waitUntil(
          async () => !alive(fixturePid) || undefined,
          'the exact fixture service to end',
        )
      }
    }
  })

  test('splits independent PTYs, preserves them on reopen, and restarts only the chosen pane', async () => {
    const ted = await startTed()
    const task = await startedTask(ted)
    const opened = await ted.ok<ShellWorkspace>('POST', workspaceRoute(task), size)
    const first = firstShell(opened)
    await ted.ok('POST', paneRoute(task, first.id, '/input'), {
      data: 'MARK=left; echo "left=$MARK"\r',
    })
    await readUntil(ted, task, first, (t) => t.includes('left=left'), first.id)
    const split = await changeWorkspace(ted, task, {
      kind: 'split',
      revision: opened.revision,
      shellId: first.id,
      direction: 'right',
      size,
    })
    const second = split.shells.find((s) => s.id !== first.id)
    if (!second) throw new Error('no second shell')
    await ted.ok('POST', paneRoute(task, second.id, '/input'), {
      data: 'echo "right=$MARK"; MARK=right\r',
    })
    const output = await readUntil(ted, task, second, (t) => t.includes('right=\r\n'), second.id)
    expect(output).not.toContain('left=left')
    expect(await ted.ok('POST', workspaceRoute(task), size)).toEqual(split)
    const fresh = await ted.ok<TaskShell>('POST', paneRoute(task, second.id, '/restart'), size)
    expect(fresh.generation).toBeGreaterThan(second.generation)
    await ted.ok('POST', paneRoute(task, first.id, '/input'), { data: 'echo "still=$MARK"\r' })
    const left = await readUntil(ted, task, first, (t) => t.includes('still=left'), first.id)
    expect(left).toContain('left=left')
    expect(await ted.ok('GET', '/activity')).toMatchObject({ shellsRunning: 2 })
  })

  test('nested layouts retain ratios, reject stale edits, and closing the last pane stays empty', async () => {
    const ted = await startTed()
    const task = await startedTask(ted)
    expect(await ted.ok('GET', workspaceRoute(task))).toEqual({
      revision: 0,
      layout: null,
      shells: [],
    })
    expect(await ted.ok('GET', '/activity')).toMatchObject({ shellsRunning: 0 })
    let ws = await ted.ok<ShellWorkspace>('POST', workspaceRoute(task), size)
    const first = firstShell(ws)
    ws = await changeWorkspace(ted, task, {
      kind: 'split',
      revision: ws.revision,
      shellId: first.id,
      direction: 'right',
      size,
    })
    const second = ws.shells[1]
    if (!second || !ws.layout || 'shellId' in ws.layout) throw new Error('no split')
    const branchId = ws.layout.id
    ws = await changeWorkspace(ted, task, {
      kind: 'ratio',
      revision: ws.revision,
      branchId,
      ratio: 0.65,
    })
    const stale = ws.revision - 1
    expect(
      (
        await ted.call('POST', `${workspaceRoute(task)}/change`, {
          kind: 'close',
          revision: stale,
          shellId: first.id,
        })
      ).status,
    ).toBe(409)
    ws = await changeWorkspace(ted, task, {
      kind: 'split',
      revision: ws.revision,
      shellId: second.id,
      direction: 'below',
      size,
    })
    expect(ws.layout).toMatchObject({
      direction: 'right',
      ratio: 0.65,
      second: { direction: 'below' },
    })
    for (const shell of [...ws.shells])
      ws = await changeWorkspace(ted, task, {
        kind: 'close',
        revision: ws.revision,
        shellId: shell.id,
      })
    expect(ws.layout).toBeNull()
    expect(ws.shells).toEqual([])
    expect(await ted.ok('POST', workspaceRoute(task), size)).toEqual(ws)
    expect(await ted.ok('GET', '/activity')).toMatchObject({ shellsRunning: 0 })
    const newWorkspace = await ted.ok<ShellWorkspace>('POST', workspaceRoute(task), {
      ...size,
      create: true,
    })
    expect(firstShell(newWorkspace).id).not.toBe(first.id)
  })

  test('pane limits and validation cannot create extra shells or target a different Task', async () => {
    const ted = await startTed()
    const task = await startedTask(ted)
    let ws = await ted.ok<ShellWorkspace>('POST', workspaceRoute(task), size)
    const first = firstShell(ws)
    for (let i = 1; i < 8; i++)
      ws = await changeWorkspace(ted, task, {
        kind: 'split',
        revision: ws.revision,
        shellId: first.id,
        direction: 'right',
        size,
      })
    const split = {
      kind: 'split',
      revision: ws.revision,
      shellId: first.id,
      direction: 'right',
      size,
    }
    expect((await ted.call('POST', `${workspaceRoute(task)}/change`, split)).status).toBe(409)
    for (const bad of [
      { ...split, direction: 'sideways' },
      { ...split, size: { cols: 0, rows: 10 } },
      { ...split, revision: -1 },
      { kind: 'ratio', revision: ws.revision, branchId: 'unknown', ratio: 2 },
    ]) {
      expect((await ted.call('POST', `${workspaceRoute(task)}/change`, bad)).status).toBe(400)
    }
    const other = await startedTask(ted)
    expect(
      (await ted.call('POST', paneRoute(other, first.id, '/input'), { data: 'x' })).status,
    ).toBe(404)
    expect(
      (
        await ted.call(
          'POST',
          `${shellRoute(task).replace('widgets', 'missing')}/panes/${first.id}/input`,
          { data: 'x' },
        )
      ).status,
    ).toBe(404)
    expect((await ted.ok<ShellWorkspace>('GET', workspaceRoute(task))).shells).toHaveLength(8)
  })

  test('closing wakes readers and worktree removal ends every pane; exited panes stay ended on reopen', async () => {
    const ted = await startTed()
    const task = await startedTask(ted)
    let ws = await ted.ok<ShellWorkspace>('POST', workspaceRoute(task), size)
    const first = firstShell(ws)
    await ted.ok('POST', paneRoute(task, first.id, '/input'), { data: 'exit 7\r' })
    await waitUntil(async () => {
      const current = await ted.ok<ShellWorkspace>('GET', workspaceRoute(task))
      return current.shells[0]?.exitCode === 7 || undefined
    }, 'the first shell to exit')
    expect(firstShell(await ted.ok('POST', workspaceRoute(task), size))).toMatchObject({
      id: first.id,
      running: false,
      exitCode: 7,
    })
    ws = await changeWorkspace(ted, task, {
      kind: 'split',
      revision: ws.revision,
      shellId: first.id,
      direction: 'below',
      size,
    })
    const second = ws.shells[1]
    if (!second) throw new Error('no second shell')
    await ted.ok('POST', paneRoute(task, second.id, '/input'), { data: 'echo "PID""=$$"\r' })
    const output = await readUntil(ted, task, second, (t) => /PID=\d+/.test(t), second.id)
    const pid = Number(/PID=(\d+)/.exec(output)?.[1])
    const current = await ted.ok<ShellOutput>(
      'GET',
      paneRoute(task, second.id, `/output?generation=${second.generation}&from=0`),
    )
    const waiting = ted.call(
      'GET',
      paneRoute(
        task,
        second.id,
        `/output?generation=${second.generation}&from=${current.next}&waitMs=25000`,
      ),
    )
    ws = await changeWorkspace(ted, task, {
      kind: 'close',
      revision: ws.revision,
      shellId: second.id,
    })
    expect((await waiting).status).toBe(404)
    await waitUntil(async () => !alive(pid) || undefined, 'closed shell to exit')
    ws = await changeWorkspace(ted, task, {
      kind: 'split',
      revision: ws.revision,
      shellId: first.id,
      direction: 'right',
      size,
    })
    expect(await ted.ok('GET', '/activity')).toMatchObject({ shellsRunning: 1 })
    await ted.ok('POST', `/tasks/${task.id}/stop`)
    await ted.ok('POST', `/tasks/${task.id}/archive`)
    await waitUntil(
      async () =>
        (await ted.ok<{ shellsRunning: number }>('GET', '/activity')).shellsRunning === 0 ||
        undefined,
      'all panes to end on archive',
    )
    for (const shell of ws.shells)
      expect(
        (await ted.call('GET', paneRoute(task, shell.id, `/output?generation=0&from=0`))).status,
      ).toBe(404)
  })

  test('all workspace, per-pane and single-shell routes refuse file and Run tokens', async () => {
    const ted = await startTed()
    const task = await startedTask(ted)
    const ws = await ted.ok<ShellWorkspace>('POST', workspaceRoute(task), size)
    const shell = firstShell(ws)
    const fileToken = JSON.parse(await readFile(path.join(home, 'daemon.json'), 'utf8'))
      .token as string
    const runToken = await devRunToken(home, daemon?.port ?? 0, daemon?.appToken ?? '')
    for (const token of [fileToken, runToken]) {
      const caller = api(daemon?.port ?? 0, token)
      for (const [method, route, body] of [
        ['GET', workspaceRoute(task), undefined],
        ['POST', workspaceRoute(task), size],
        [
          'POST',
          `${workspaceRoute(task)}/change`,
          { kind: 'close', revision: ws.revision, shellId: shell.id },
        ],
        ['POST', paneRoute(task, shell.id), size],
        ['POST', paneRoute(task, shell.id, '/restart'), size],
        ['POST', paneRoute(task, shell.id, '/input'), { data: 'x' }],
        ['POST', paneRoute(task, shell.id, '/resize'), size],
        ['GET', paneRoute(task, shell.id, '/output?generation=0&from=0'), undefined],
        ['POST', shellRoute(task), size],
        ['GET', shellRoute(task, `/output?generation=${shell.generation}&from=0`), undefined],
      ] as const)
        expect((await caller.call(method, route, body)).status).toBe(403)
    }
    expect((await ted.ok<ShellWorkspace>('GET', workspaceRoute(task))).shells).toHaveLength(1)
  })
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const realpathOf = (file: string) => realpath(file)

async function fakeEditors(names: string[]): Promise<{ bin: string; log: string }> {
  const bin = path.join(scratch, 'bin')
  const log = path.join(scratch, 'editor.log')
  await mkdir(bin, { recursive: true })
  for (const name of names) {
    const script = [
      '#!/bin/sh',
      `line='${name}'`,
      'for a in "$@"; do line="$line [$a]"; done',
      `printf '%s\\n' "$line" >> '${log}'`,
      '',
    ].join('\n')
    await writeFile(path.join(bin, name), script, { mode: 0o755 })
  }
  return { bin, log }
}

const opened = async (log: string, lines: number) =>
  waitUntil(async () => {
    const text = await readFile(log, 'utf8').catch(() => '')
    const found = text.split('\n').filter((l) => l !== '')
    return found.length >= lines ? found : undefined
  }, 'the editor to start')

describe('Open in editor', () => {
  test('lists the editors on the login shell’s PATH and has no default', async () => {
    const { bin } = await fakeEditors(['code', 'zed', 'not-an-editor'])
    vi.stubEnv('PATH', `${bin}${path.delimiter}/bin`)
    const ted = await start()

    const found = await ted.ok<FoundEditor[]>('GET', '/editors')
    const settings = await ted.ok<MachineSettings>('GET', '/settings')

    expect(found).toEqual([
      { id: 'code', name: 'VS Code', path: path.join(bin, 'code') },
      { id: 'zed', name: 'Zed', path: path.join(bin, 'zed') },
    ])
    expect(settings.editor).toBeNull()
  })

  test('refuses until an editor is chosen and refuses files outside the worktree, then opens the worktree and a file at a line; a custom command gets the path, line and column as separate arguments, never through a shell', async () => {
    const { bin, log } = await fakeEditors(['code', 'cursor', 'zed', 'my editor'])
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`)
    const ted = await startTed()
    const task = await startedTask(ted)
    const worktree = task.repos[0]?.worktree ?? ''
    const route = `/tasks/${task.id}/repos/widgets/open-in-editor`

    expect((await ted.call('POST', route)).status).toBe(409)

    await ted.ok('PATCH', '/settings', { editor: 'code' })
    await symlink(scratch, path.join(worktree, 'escape'))
    const open = (file: string) => ted.call('POST', route, { file })
    expect((await open('../../../../etc/passwd')).status).toBe(400)
    expect((await open('/etc/passwd')).status).toBe(400)
    expect((await open('escape/bin/code')).status).toBe(400)
    expect((await open('missing.txt')).status).toBe(404)
    expect(await readFile(log, 'utf8').catch(() => '')).toBe('')

    await ted.ok('POST', route)
    await ted.ok('POST', route, { file: 'README.md', line: 12, column: 3 })
    await ted.ok('PATCH', '/settings', { editor: 'cursor' })
    await ted.ok('POST', route, { file: 'README.md', line: 4 })
    await ted.ok('PATCH', '/settings', { editor: 'zed' })
    await ted.ok('POST', route, { file: 'README.md', line: 7, column: 2 })

    const file = path.join(worktree, 'README.md')
    expect((await opened(log, 4)).sort()).toEqual([
      `code [${worktree}]`,
      `code [${worktree}] [--goto] [${file}:12:3]`,
      `cursor [${worktree}] [--goto] [${file}:4:1]`,
      `zed [${worktree}] [${file}:7:2]`,
    ])

    const name = 'odd $(touch pwned); name.txt'
    await writeFile(path.join(worktree, name), 'x\n')
    await ted.ok('PATCH', '/settings', {
      editor: 'custom',
      editorCommand: `"${path.join(bin, 'my editor')}" --at {line}:{column} {path}`,
    })
    await ted.ok('POST', route, { file: name, line: 5, column: 9 })

    const lines = await opened(log, 5)
    expect(lines).toHaveLength(5)
    expect(lines.filter((line) => line.startsWith('my editor'))).toEqual([
      `my editor [--at] [5:9] [${path.join(worktree, name)}]`,
    ])
    await expect(readFile(path.join(worktree, 'pwned'))).rejects.toThrow()
  })
})
