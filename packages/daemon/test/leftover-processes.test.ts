import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { parseLsof, processesInside, taskFolder } from '../src/leftover-processes.ts'

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
