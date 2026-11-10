import { randomUUID } from 'node:crypto'
import {
  type DaemonEvent,
  maxShellPanes,
  type ShellChange,
  type ShellLayout,
  type ShellOutput,
  type ShellSize,
  type ShellWorkspace,
  type TaskShell,
} from '@ted/protocol'
import * as pty from 'node-pty'
import { loginShell } from './command-env.ts'
import { RequestError } from './errors.ts'
import type { IdleTimer } from './idle.ts'

export interface ShellTarget {
  taskId: string
  repo: string
  worktree: string
  env: NodeJS.ProcessEnv
}

export interface ShellsOptions {
  target(ref: string, repo: string): Promise<ShellTarget>
  subscribe(listener: (event: DaemonEvent) => void): () => void
  idle?: IdleTimer
  program?: () => string
  onRunning?: (count: number) => void
  scrollbackChars?: number
  maxWaitMs?: number
}

export interface Shells {
  workspace(ref: string, repo: string, size?: ShellSize, create?: boolean): Promise<ShellWorkspace>
  change(ref: string, repo: string, change: ShellChange): Promise<ShellWorkspace>
  open(ref: string, repo: string, size: ShellSize, id?: string): Promise<TaskShell>
  restart(ref: string, repo: string, size: ShellSize, id?: string): Promise<TaskShell>
  write(ref: string, repo: string, data: string, id?: string): Promise<void>
  resize(ref: string, repo: string, size: ShellSize, id?: string): Promise<void>
  read(
    ref: string,
    repo: string,
    query: { generation: number; from: number; waitMs: number },
    signal: AbortSignal,
    id?: string,
  ): Promise<ShellOutput>
  close(): void
}

interface Shell {
  id: string
  taskId: string
  repo: string
  path: string
  generation: number
  process: pty.IPty | undefined
  text: string
  start: number
  exitCode?: number
  waiters: Set<() => void>
  release: (() => void) | undefined
}

const keyOf = (taskId: string, repo: string) => `${taskId}\0${repo}`

export function createShells(options: ShellsOptions): Shells {
  const shells = new Map<string, Shell>()
  const workspaces = new Map<
    string,
    { path: string; revision: number; layout: ShellLayout | null }
  >()
  const scrollback = options.scrollbackChars ?? 512 * 1024
  const maxWaitMs = options.maxWaitMs ?? 25_000
  const program = options.program ?? (() => loginShell(process.env))
  const resolving = new Set<Set<string>>()
  let closed = false
  let reported = 0
  const report = () => {
    const count = [...shells.values()].filter((s) => s.process !== undefined).length
    if (count === reported) return
    reported = count
    options.onRunning?.(count)
  }

  const unsubscribe = options.subscribe((event) => {
    if (event.type === 'task-deleted') {
      for (const changed of resolving) changed.add(event.taskId)
      for (const key of workspaces.keys()) {
        if (key.startsWith(`${event.taskId}\0`)) workspaces.delete(key)
      }
      for (const shell of shells.values()) {
        if (shell.taskId === event.taskId) end(shell)
      }
    } else if (event.type === 'task-updated') {
      for (const changed of resolving) changed.add(event.task.id)
      for (const [key, workspace] of workspaces) {
        if (!key.startsWith(`${event.task.id}\0`)) continue
        if (
          !event.task.repos.some(
            (r) =>
              key === keyOf(event.task.id, r.name) && !r.removed && r.worktree === workspace.path,
          )
        )
          workspaces.delete(key)
      }
      for (const shell of shells.values()) {
        if (shell.taskId !== event.task.id) continue
        const repo = event.task.repos.find((r) => r.name === shell.repo)
        if (!repo || repo.removed || repo.worktree !== shell.path) end(shell)
      }
    }
  })

  async function access<T>(
    ref: string,
    repo: string,
    action: (target: ShellTarget) => T,
  ): Promise<T> {
    if (closed) throw new RequestError(503, 'Task shells are shutting down')
    const changed = new Set<string>()
    resolving.add(changed)
    try {
      const target = await options.target(ref, repo)
      if (closed) throw new RequestError(503, 'Task shells are shutting down')
      if (changed.has(target.taskId)) return access(ref, repo, action)
      return action(target)
    } finally {
      resolving.delete(changed)
    }
  }

  function end(shell: Shell): void {
    shells.delete(shell.id)
    stop(shell)
    wake(shell)
    report()
  }

  function stop(shell: Shell): void {
    const running = shell.process
    shell.process = undefined
    shell.release?.()
    shell.release = undefined
    if (!running) return
    try {
      process.kill(-running.pid, 'SIGHUP')
    } catch {}
    try {
      running.kill('SIGHUP')
    } catch {}
  }

  function wake(shell: Shell): void {
    for (const waiter of shell.waiters) waiter()
    shell.waiters.clear()
  }

  function append(shell: Shell, data: string): void {
    shell.text += data
    if (shell.text.length > scrollback) {
      let cut = shell.text.length - scrollback
      const newline = shell.text.indexOf('\n', cut)
      if (newline >= 0) cut = newline + 1
      shell.text = shell.text.slice(cut)
      shell.start += cut
    }
    wake(shell)
  }

  function launch(shell: Shell, target: ShellTarget, size: ShellSize): void {
    const env = {
      ...target.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'TED',
    }
    const child = pty.spawn(program(), ['-l'], {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: target.worktree,
      env: env as Record<string, string>,
    })
    shell.generation += 1
    shell.text = ''
    shell.start = 0
    delete shell.exitCode
    shell.process = child
    shell.release = options.idle?.hold()
    const generation = shell.generation
    child.onData((data) => {
      if (shell.generation === generation) append(shell, data)
    })
    child.onExit(({ exitCode }) => {
      if (shell.generation !== generation || shell.process !== child) return
      shell.process = undefined
      shell.exitCode = exitCode
      shell.release?.()
      shell.release = undefined
      wake(shell)
      report()
    })
    report()
  }

  function info(shell: Shell): TaskShell {
    return {
      id: shell.id,
      taskId: shell.taskId,
      repo: shell.repo,
      path: shell.path,
      generation: shell.generation,
      running: shell.process !== undefined,
      ...(shell.exitCode !== undefined && { exitCode: shell.exitCode }),
    }
  }

  function members(target: ShellTarget): Shell[] {
    return [...shells.values()].filter((s) => s.taskId === target.taskId && s.repo === target.repo)
  }

  function workspaceFor(target: ShellTarget) {
    const key = keyOf(target.taskId, target.repo)
    let workspace = workspaces.get(key)
    if (workspace && workspace.path !== target.worktree) {
      for (const shell of members(target)) end(shell)
      workspaces.delete(key)
      workspace = undefined
    }
    if (!workspace) {
      workspace = { path: target.worktree, revision: 0, layout: null }
      workspaces.set(key, workspace)
    }
    return workspace
  }

  function snapshot(target: ShellTarget): ShellWorkspace {
    const workspace = workspaceFor(target)
    return {
      revision: workspace.revision,
      layout: workspace.layout,
      shells: members(target).map(info),
    }
  }

  function create(target: ShellTarget, size: ShellSize): Shell {
    const shell: Shell = {
      id: randomUUID(),
      taskId: target.taskId,
      repo: target.repo,
      path: target.worktree,
      generation: 0,
      process: undefined,
      text: '',
      start: 0,
      waiters: new Set(),
      release: undefined,
    }
    launch(shell, target, size)
    shells.set(shell.id, shell)
    report()
    return shell
  }

  function find(target: ShellTarget, id?: string): Shell {
    const shell = id === undefined ? members(target)[0] : shells.get(id)
    if (
      !shell ||
      shell.taskId !== target.taskId ||
      shell.repo !== target.repo ||
      shell.path !== target.worktree
    ) {
      throw new RequestError(404, `No shell is open for ${target.repo}`)
    }
    return shell
  }

  async function existing(ref: string, repo: string, id?: string): Promise<Shell> {
    return access(ref, repo, (target) => find(target, id))
  }

  async function start(ref: string, repo: string, size: ShellSize, fresh: boolean, id?: string) {
    return access(ref, repo, (target) => {
      const workspace = workspaceFor(target)
      let shell: Shell
      if (id === undefined && members(target).length === 0) {
        shell = create(target, size)
        workspace.layout = { shellId: shell.id }
        workspace.revision++
      } else {
        shell = find(target, id)
        if (fresh) stop(shell)
        if (!shell.process && (fresh || id === undefined)) {
          launch(shell, target, size)
          wake(shell)
        } else shell.process?.resize(size.cols, size.rows)
      }
      return info(shell)
    })
  }

  function replace(
    layout: ShellLayout,
    id: string,
    replacement: ShellLayout | null,
  ): ShellLayout | null {
    if ('shellId' in layout) return layout.shellId === id ? replacement : layout
    const first = replace(layout.first, id, replacement)
    const second = replace(layout.second, id, replacement)
    return first && second ? { ...layout, first, second } : (first ?? second)
  }

  function ratio(layout: ShellLayout, id: string, value: number): ShellLayout {
    if ('shellId' in layout) return layout
    if (layout.id === id) return { ...layout, ratio: value }
    return {
      ...layout,
      first: ratio(layout.first, id, value),
      second: ratio(layout.second, id, value),
    }
  }

  function hasBranch(layout: ShellLayout, id: string): boolean {
    return (
      !('shellId' in layout) &&
      (layout.id === id || hasBranch(layout.first, id) || hasBranch(layout.second, id))
    )
  }

  return {
    async workspace(ref, repo, size, createEmpty = false) {
      return access(ref, repo, (target) => {
        const workspace = workspaceFor(target)
        if (size && !workspace.layout && (workspace.revision === 0 || createEmpty)) {
          const shell = create(target, size)
          workspace.layout = { shellId: shell.id }
          workspace.revision++
        }
        return snapshot(target)
      })
    },

    async change(ref, repo, change) {
      return access(ref, repo, (target) => {
        const workspace = workspaceFor(target)
        if (workspace.revision !== change.revision)
          throw new RequestError(409, 'The shell layout changed. Try again.')
        const layout = workspace.layout
        if (!layout) throw new RequestError(404, 'No shell is open for this repo')
        if (change.kind === 'ratio') {
          if (!hasBranch(layout, change.branchId))
            throw new RequestError(404, 'No such pane divider')
          workspace.layout = ratio(layout, change.branchId, change.ratio)
        } else {
          const shell = find(target, change.shellId)
          if (change.kind === 'split') {
            if (members(target).length >= maxShellPanes)
              throw new RequestError(
                409,
                `Up to ${maxShellPanes} panes per repo. Close one to split again.`,
              )
            const added = create(target, change.size)
            workspace.layout = replace(layout, shell.id, {
              id: randomUUID(),
              direction: change.direction,
              ratio: 0.5,
              first: { shellId: shell.id },
              second: { shellId: added.id },
            })
          } else {
            workspace.layout = replace(layout, shell.id, null)
            end(shell)
          }
        }
        workspace.revision++
        return snapshot(target)
      })
    },

    open: (ref, repo, size, id) => start(ref, repo, size, false, id),
    restart: (ref, repo, size, id) => start(ref, repo, size, true, id),

    async write(ref, repo, data, id) {
      const shell = await existing(ref, repo, id)
      if (!shell.process) throw new RequestError(409, 'The shell has ended. Restart it first.')
      shell.process.write(data)
    },

    async resize(ref, repo, size, id) {
      const shell = await existing(ref, repo, id)
      shell.process?.resize(size.cols, size.rows)
    },

    async read(ref, repo, query, signal, id) {
      const shell = await existing(ref, repo, id)
      const end = () => shell.start + shell.text.length
      let reset = query.generation !== shell.generation || query.from < shell.start
      let from = reset ? shell.start : Math.min(query.from, end())
      const waitMs = Math.min(Math.max(query.waitMs, 0), maxWaitMs)
      if (!reset && from === end() && shell.process && waitMs > 0 && !signal.aborted) {
        const generation = shell.generation
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer)
            signal.removeEventListener('abort', done)
            shell.waiters.delete(done)
            resolve()
          }
          const timer = setTimeout(done, waitMs)
          signal.addEventListener('abort', done)
          shell.waiters.add(done)
        })
        if (shells.get(shell.id) !== shell) {
          throw new RequestError(404, `No shell is open for ${repo}`)
        }
        if (shell.generation !== generation || from < shell.start) {
          reset = true
          from = shell.start
        }
      }
      return {
        generation: shell.generation,
        data: shell.text.slice(from - shell.start),
        next: end(),
        reset,
        running: shell.process !== undefined,
        ...(shell.exitCode !== undefined && { exitCode: shell.exitCode }),
      }
    },

    close() {
      closed = true
      unsubscribe()
      workspaces.clear()
      resolving.clear()
      for (const shell of [...shells.values()]) end(shell)
    },
  }
}
