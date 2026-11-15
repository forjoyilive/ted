import { mkdir, mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { lsofArgs, parseLsof, processesInside, taskFolder } from '../src/leftover-processes.ts'
import { sweepLeftovers } from '../src/tasks/leftovers.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-leftovers-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('lsof field output gives each process’s working folder and executable', () => {
  const output = [
    'p101',
    'fcwd',
    'n/home/ted/worktrees/NB-1/widgets',
    'ftxt',
    'n/bin/sleep',
    'p202',
    'fcwd',
    'n/',
    'pnot-a-pid',
    'n/home/ted/worktrees/NB-2',
    '',
  ].join('\n')
  expect(parseLsof(output)).toEqual([
    { pid: 101, path: '/home/ted/worktrees/NB-1/widgets' },
    { pid: 101, path: '/bin/sleep' },
    { pid: 202, path: '/' },
  ])
})

test('lsof never checks files on disk and never names a file, so it can’t reach an attached drive', () => {
  for (const args of [lsofArgs(501, 'cwd,txt'), lsofArgs(501), lsofArgs(undefined)]) {
    expect(args).toContain('-b')
    expect(args.every((arg) => arg.startsWith('-') || /^[\d,a-z]+$/.test(arg))).toBe(true)
  }
  expect(lsofArgs(501, 'cwd,txt')).toEqual(
    expect.arrayContaining(['-a', '-u', '501', '-d', 'cwd,txt', '-Fpn']),
  )
})

test('a process matches only inside the Task’s own folder, and TED’s own process never does', async () => {
  const list = async () => [
    { pid: 11, path: '/home/ted/worktrees/NB-1' },
    { pid: 12, path: '/home/ted/worktrees/NB-1/widgets/node_modules/.bin/ted' },
    { pid: 13, path: '/home/ted/worktrees/NB-10/widgets' },
    { pid: 14, path: '/home/ted/worktrees/NB-1-old' },
    { pid: 15, path: '/home/ted/plans/NB-1' },
    { pid: process.pid, path: '/home/ted/worktrees/NB-1/widgets' },
    { pid: 1, path: '/home/ted/worktrees/NB-1' },
  ]
  expect((await processesInside(['/home/ted/worktrees/NB-1'], list)).sort()).toEqual([11, 12])
  expect(await processesInside([], list)).toEqual([])
})

test('a Task folder is matched by its real path, and never through a link', async () => {
  const worktrees = path.join(dir, 'worktrees')
  await mkdir(path.join(worktrees, 'NB-1'), { recursive: true })
  await mkdir(path.join(dir, 'elsewhere'))
  await symlink(path.join(dir, 'elsewhere'), path.join(worktrees, 'NB-2'))
  const real = await realpath(worktrees)

  expect(await taskFolder(worktrees, 'NB-1')).toBe(path.join(real, 'NB-1'))
  expect(await taskFolder(worktrees, 'NB-3')).toBe(path.join(real, 'NB-3'))
  expect(await taskFolder(worktrees, 'NB-2')).toBeUndefined()
  expect(await taskFolder(worktrees, '../NB-1')).toBeUndefined()
  expect(await taskFolder(path.join(dir, 'missing'), 'NB-1')).toBeUndefined()
})

test('the start-up sweep removes only under plain roots, skips held Tasks and lists again before signalling', async () => {
  const home = path.join(dir, 'home')
  const outside = path.join(dir, 'outside')
  await mkdir(path.join(home, 'worktrees', 'NB-99', 'widgets'), { recursive: true })
  await mkdir(path.join(home, 'worktrees', 'NB-2', 'widgets'), { recursive: true })
  await mkdir(path.join(outside, 'NB-99'), { recursive: true })
  await symlink(outside, path.join(home, 'sandbox'))
  const real = await realpath(path.join(home, 'worktrees'))
  const lists: number[] = []
  const list = async () => {
    lists.push(lists.length)
    return lists.length === 1 ? [{ pid: 2 ** 30, path: path.join(real, 'NB-99', 'widgets') }] : []
  }

  const swept = await sweepLeftovers({
    home,
    list,
    graceMs: 0,
    hold: async (name, work) => {
      if (name !== 'NB-2') await work()
    },
  })

  expect(swept).toEqual({ tasks: ['NB-99'], processes: 0, folders: 1 })
  expect(lists.length).toBe(2)
  await expect(stat(path.join(home, 'worktrees', 'NB-99'))).rejects.toThrow()
  expect((await stat(path.join(home, 'worktrees', 'NB-2'))).isDirectory()).toBe(true)
  expect((await stat(path.join(outside, 'NB-99'))).isDirectory()).toBe(true)
})

test('a start-up sweep stopped while it lists processes removes nothing', async () => {
  const home = path.join(dir, 'home')
  await mkdir(path.join(home, 'worktrees', 'NB-99', 'widgets'), { recursive: true })
  const stop = new AbortController()

  const swept = await sweepLeftovers({
    home,
    signal: stop.signal,
    list: async () => {
      stop.abort()
      return []
    },
    hold: (_name, work) => work(),
  })

  expect(swept).toEqual({ tasks: [], processes: 0, folders: 0 })
  expect((await stat(path.join(home, 'worktrees', 'NB-99'))).isDirectory()).toBe(true)
})
