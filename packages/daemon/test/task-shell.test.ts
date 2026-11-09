import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  Factory,
  FoundEditor,
  MachineSettings,
  ShellOutput,
  Task,
  TaskShell,
} from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  commitToOrigin,
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
): Promise<string> {
  let text = ''
  let from = 0
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const out = await ted.ok<ShellOutput>(
      'GET',
      shellRoute(task, `/output?generation=${shell.generation}&from=${from}&waitMs=2000`),
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
  test('opens the login shell in the worktree with worktree.env and TED_TASK but no TED_RUN', async () => {
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
  })

  test('keeps one shell per repo across opens, and Restart starts a new one', async () => {
    const ted = await startTed()
    const task = await startedTask(ted)
    const first = await ted.ok<TaskShell>('POST', shellRoute(task), size)
    await type(ted, task, 'MARK=kept; echo "[$MARK]"\r')
    await readUntil(ted, task, first, (t) => t.includes('[kept]'))

    const again = await ted.ok<TaskShell>('POST', shellRoute(task), size)
    await type(ted, task, 'echo "<$MARK>"\r')
    const text = await readUntil(ted, task, again, (t) => t.includes('<kept>'))
    expect(again.generation).toBe(first.generation)
    expect(text).toContain('[kept]')

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

  test('only the app can open or read a shell', async () => {
    const ted = await startTed()
    const task = await startedTask(ted)
    const shell = await ted.ok<TaskShell>('POST', shellRoute(task), size)
    const token = JSON.parse(await readFile(path.join(home, 'daemon.json'), 'utf8')).token as string
    const file = api(daemon?.port ?? 0, token)

    const read = await file.call(
      'GET',
      shellRoute(task, `/output?generation=${shell.generation}&from=0`),
    )
    const open = await file.call('POST', shellRoute(task), size)

    expect(read.status).toBe(403)
    expect(open.status).toBe(403)
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

  test('refuses until an editor is chosen, then opens the worktree and a file at a line', async () => {
    const { bin, log } = await fakeEditors(['code', 'cursor', 'zed'])
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`)
    const ted = await startTed()
    const task = await startedTask(ted)
    const worktree = task.repos[0]?.worktree ?? ''
    const route = `/tasks/${task.id}/repos/widgets/open-in-editor`

    expect((await ted.call('POST', route)).status).toBe(409)

    await ted.ok('PATCH', '/settings', { editor: 'code' })
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
  })

  test('a custom command gets the path, line and column as separate arguments, never through a shell', async () => {
    const { bin, log } = await fakeEditors(['my editor'])
    const ted = await startTed()
    const task = await startedTask(ted)
    const worktree = task.repos[0]?.worktree ?? ''
    const name = 'odd $(touch pwned); name.txt'
    await writeFile(path.join(worktree, name), 'x\n')

    await ted.ok('PATCH', '/settings', {
      editor: 'custom',
      editorCommand: `"${path.join(bin, 'my editor')}" --at {line}:{column} {path}`,
    })
    await ted.ok('POST', `/tasks/${task.id}/repos/widgets/open-in-editor`, {
      file: name,
      line: 5,
      column: 9,
    })

    expect(await opened(log, 1)).toEqual([`my editor [--at] [5:9] [${path.join(worktree, name)}]`])
    await expect(readFile(path.join(worktree, 'pwned'))).rejects.toThrow()
  })

  test('refuses files outside the worktree', async () => {
    const { bin, log } = await fakeEditors(['code'])
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`)
    const ted = await startTed()
    const task = await startedTask(ted)
    const worktree = task.repos[0]?.worktree ?? ''
    await ted.ok('PATCH', '/settings', { editor: 'code' })
    await symlink(scratch, path.join(worktree, 'escape'))
    const open = (file: string) =>
      ted.call('POST', `/tasks/${task.id}/repos/widgets/open-in-editor`, { file })

    expect((await open('../../../../etc/passwd')).status).toBe(400)
    expect((await open('/etc/passwd')).status).toBe(400)
    expect((await open('escape/bin/code')).status).toBe(400)
    expect((await open('missing.txt')).status).toBe(404)
    expect(await readFile(log, 'utf8').catch(() => '')).toBe('')
  })
})
