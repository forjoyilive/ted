import type { DaemonEvent, ShellOutput, ShellSize, TaskShell } from '@ted/protocol'
import * as pty from 'node-pty'
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
  scrollbackChars?: number
  maxWaitMs?: number
}

export interface Shells {
  open(ref: string, repo: string, size: ShellSize): Promise<TaskShell>
  restart(ref: string, repo: string, size: ShellSize): Promise<TaskShell>
  write(ref: string, repo: string, data: string): Promise<void>
  resize(ref: string, repo: string, size: ShellSize): Promise<void>
  read(
    ref: string,
    repo: string,
    query: { generation: number; from: number; waitMs: number },
    signal: AbortSignal,
  ): Promise<ShellOutput>
  close(): void
}

interface Shell {
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

export function loginShell(env: NodeJS.ProcessEnv): string {
  const given = env.SHELL
  if (given?.startsWith('/')) return given
  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh'
}

export function createShells(options: ShellsOptions): Shells {
  const shells = new Map<string, Shell>()
  const scrollback = options.scrollbackChars ?? 512 * 1024
  const maxWaitMs = options.maxWaitMs ?? 25_000

  const unsubscribe = options.subscribe((event) => {
    if (event.type === 'task-deleted') {
      for (const shell of shells.values()) {
        if (shell.taskId === event.taskId) end(shell)
      }
    } else if (event.type === 'task-updated') {
      for (const shell of shells.values()) {
        if (shell.taskId !== event.task.id) continue
        const repo = event.task.repos.find((r) => r.name === shell.repo)
        if (!repo || repo.removed || repo.worktree !== shell.path) end(shell)
      }
    }
  })

  function end(shell: Shell): void {
    shells.delete(keyOf(shell.taskId, shell.repo))
    stop(shell)
    wake(shell)
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
    const child = pty.spawn(loginShell(target.env), ['-l'], {
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
    })
  }

  function info(shell: Shell): TaskShell {
    return {
      taskId: shell.taskId,
      repo: shell.repo,
      path: shell.path,
      generation: shell.generation,
      running: shell.process !== undefined,
      ...(shell.exitCode !== undefined && { exitCode: shell.exitCode }),
    }
  }

  async function existing(ref: string, repo: string): Promise<Shell> {
    const target = await options.target(ref, repo)
    const shell = shells.get(keyOf(target.taskId, target.repo))
    if (!shell) throw new RequestError(404, `No shell is open for ${repo}`)
    return shell
  }

  async function start(ref: string, repo: string, size: ShellSize, fresh: boolean) {
    const target = await options.target(ref, repo)
    const key = keyOf(target.taskId, target.repo)
    let shell = shells.get(key)
    if (shell && shell.path !== target.worktree) {
      end(shell)
      shell = undefined
    }
    if (!shell) {
      shell = {
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
      shells.set(key, shell)
    }
    if (fresh) stop(shell)
    if (!shell.process) {
      launch(shell, target, size)
      wake(shell)
    } else {
      shell.process.resize(size.cols, size.rows)
    }
    return info(shell)
  }

  return {
    open: (ref, repo, size) => start(ref, repo, size, false),
    restart: (ref, repo, size) => start(ref, repo, size, true),

    async write(ref, repo, data) {
      const shell = await existing(ref, repo)
      if (!shell.process) throw new RequestError(409, 'The shell has ended. Restart it first.')
      shell.process.write(data)
    },

    async resize(ref, repo, size) {
      const shell = await existing(ref, repo)
      shell.process?.resize(size.cols, size.rows)
    },

    async read(ref, repo, query, signal) {
      const shell = await existing(ref, repo)
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
        if (shells.get(keyOf(shell.taskId, shell.repo)) !== shell) {
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
      unsubscribe()
      for (const shell of [...shells.values()]) end(shell)
    },
  }
}
