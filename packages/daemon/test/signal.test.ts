import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { signalGroup, signalProcess } from '../src/signal.ts'
import { killAppHosts, killRunHosts } from './helpers.ts'

let home: string
let sent: number[]

beforeEach(async () => {
  sent = []
  vi.spyOn(process, 'kill').mockImplementation((pid) => {
    sent.push(pid)
    return true
  })
  if (!vi.isMockFunction(process.kill)) throw new Error('process.kill is not stubbed')
  home = await mkdtemp(path.join(tmpdir(), 'ted-signal-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(home, { recursive: true, force: true })
})

async function writeRunHost(record: Record<string, unknown>): Promise<void> {
  const dir = path.join(home, 'runs', '00000000-0000-4000-8000-000000000001')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'host.log'), `${JSON.stringify({ t: 'start', ...record })}\n`)
}

async function writeAppHost(record: Record<string, unknown>): Promise<void> {
  const dir = path.join(home, 'apps', 'NB-1', 'web', 'web')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'host.jsonl'), `${JSON.stringify({ t: 'start', ...record })}\n`)
}

const unsafe = [-1, 0, 1, 1.5, -4242, Number.NaN, '4242', null, undefined]

test.each(unsafe)('signalProcess sends nothing to %s', (pid) => {
  signalProcess(pid, 'SIGKILL')
  expect(sent).toEqual([])
})

test.each(unsafe)('signalGroup sends nothing to %s', (pid) => {
  signalGroup(pid, 'SIGKILL')
  expect(sent).toEqual([])
})

test('signalProcess and signalGroup signal a real pid', () => {
  signalProcess(4242, 'SIGKILL')
  signalGroup(4242, 'SIGKILL')
  expect(sent).toEqual([4242, -4242])
})

test.each([-1, 0, 1, 1.5])('killRunHosts sends nothing to agent pid %s', async (agentPid) => {
  await writeRunHost({ hostPid: agentPid, agentPid })
  await killRunHosts(home)
  expect(sent).toEqual([])
})

test('killRunHosts signals the agent and the host', async () => {
  await writeRunHost({ hostPid: 4243, agentPid: 4242 })
  await killRunHosts(home)
  expect(sent).toEqual([4242, 4243])
})

test.each([-1, 0, 1, 1.5])('killAppHosts sends nothing to App pid %s', async (pid) => {
  await writeAppHost({ hostPid: pid, pid })
  await killAppHosts(home)
  expect(sent).toEqual([])
})

test('killAppHosts signals the App’s group and the host', async () => {
  await writeAppHost({ hostPid: 4243, pid: 4242 })
  await killAppHosts(home)
  expect(sent).toEqual([-4242, 4243])
})
