import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { prepareDemo, stopDemo } from '../src/dev/demo.ts'
import {
  checkDemoHome,
  demoEnvironment,
  demoHome,
  demoVersion,
  markDemo,
  withDemoEnvironment,
} from '../src/dev/home.ts'

let folder: string
beforeEach(async () => {
  const parent = path.resolve('node_modules/.cache/ted-home')
  await mkdir(parent, { recursive: true })
  folder = await mkdtemp(path.join(parent, 'demo-boundary-'))
})
afterEach(async () => {
  await rm(folder, { recursive: true, force: true })
})

test('uses a separate default and rejects protected homes and their ancestors', async () => {
  expect(demoHome({})).toBe(path.join(homedir(), '.ted-dev-demo'))
  for (const home of [
    homedir(),
    '/',
    path.join(homedir(), '.ted'),
    path.join(homedir(), '.ted-dev'),
    path.join(homedir(), '.ted', 'store'),
  ]) {
    await expect(checkDemoHome(home)).rejects.toThrow('separate demo home')
  }
})

test('refuses unknown data and symlinks without changing them', async () => {
  await writeFile(path.join(folder, 'keep.txt'), 'Important data')
  await expect(prepareDemo(folder, true)).rejects.toThrow('unrecognized')
  expect(await readdir(folder)).toEqual(['keep.txt'])
  const link = path.join(folder, 'linked-home')
  await symlink(path.join(homedir(), '.ted'), link)
  await expect(checkDemoHome(link)).rejects.toThrow()
})

test('requires explicit reset for incomplete or incompatible demos', async () => {
  await markDemo(folder, { version: demoVersion, complete: false })
  await expect(prepareDemo(folder)).rejects.toThrow('--reset')
  await markDemo(folder, { version: demoVersion + 1, complete: true })
  await expect(prepareDemo(folder)).rejects.toThrow('--reset')
})

test('demo children receive only local fixtures and no inherited credentials or capabilities', () => {
  const env = demoEnvironment(folder, {
    PATH: '/usr/bin',
    HOME: homedir(),
    TED_HOME: path.join(homedir(), '.ted'),
    TED_RUN_CAPABILITY: 'secret',
    OPENAI_API_KEY: 'secret',
    ANTHROPIC_AUTH_TOKEN: 'secret',
    CUSTOM_PASSWORD: 'secret',
    GITHUB_TOKEN: 'secret',
    GIT_CONFIG_COUNT: '99',
    TED_CLAUDE_BIN: '/real/claude',
    TED_LOAD_FILE: '/host/load',
    TED_LOW_PRIORITY: 'on',
    NODE_OPTIONS: '--require=real-code',
  })
  expect(Object.values(env)).not.toContain('secret')
  expect(env.TED_HOME).toBe(folder)
  expect(env.TED_CLAUDE_BIN).toBe(path.join(folder, 'bin', 'stub-claude.mjs'))
  expect(env.TED_CODEX_BIN).toBe(path.join(folder, 'bin', 'stub-codex.mjs'))
  expect(env.TED_GH_BIN).toBe(path.join(folder, 'bin', 'stub-gh.mjs'))
  expect(env.TED_KEYRING_MODULE).toMatch(/stub-keyring.ts$/)
  expect(env.TED_LOAD_FILE).toMatch(/test\/fixtures\/load.txt$/)
  expect(env.TED_LOW_PRIORITY).toBe('off')
  expect(env.GIT_ALLOW_PROTOCOL).toBe('file')
  expect(env.NODE_OPTIONS).toBeUndefined()
})

test('refuses a demo daemon pointer linked to another home', async () => {
  await markDemo(folder, { version: demoVersion, complete: true })
  await symlink(path.join(homedir(), '.ted', 'daemon.json'), path.join(folder, 'daemon.json'))
  await expect(checkDemoHome(folder)).rejects.toThrow('daemon.json must not be a link')
})

test('reset recovers an incomplete demo with stale daemon metadata', async () => {
  const pid = 2_147_483_647
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  await markDemo(folder, { version: demoVersion, complete: false })
  await writeFile(
    path.join(folder, 'daemon.json'),
    JSON.stringify({
      port: 9,
      token: 'demo-fixture-token',
      pid,
      version: '0.1.3',
    }),
  )
  expect((await prepareDemo(folder, true)).complete).toBe(false)
  expect(await readdir(folder)).not.toContain('daemon.json')
})

test('reset and stop refuse while the demo app is open', async () => {
  await markDemo(folder, { version: demoVersion, complete: false })
  await mkdir(path.join(folder, 'electron'))
  await symlink(`demo-host-${process.pid}`, path.join(folder, 'electron', 'SingletonLock'))
  await expect(prepareDemo(folder, true)).rejects.toThrow('Quit the demo app')
  await expect(stopDemo(folder)).rejects.toThrow('Quit the demo app')
  expect(await readdir(folder)).toContain('demo.json')
})

test('stop never signals a recorded pid that holds none of the demo’s locks', async () => {
  await markDemo(folder, { version: demoVersion, complete: true })
  const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: process.env,
    stdio: 'ignore',
  })
  try {
    const dir = path.join(folder, 'runs', '00000000-0000-4000-8000-000000000001')
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, 'host.log'),
      `${JSON.stringify({ t: 'start', hostPid: stranger.pid, agentPid: null })}\n`,
    )
    await stopDemo(folder)
    expect(stranger.exitCode).toBeNull()
    expect(stranger.signalCode).toBeNull()
    expect(await readdir(folder)).toContain('quit-mark')
  } finally {
    stranger.kill('SIGKILL')
  }
})

test('stop refuses a folder without a demo and leaves an idle demo quit', async () => {
  await expect(stopDemo(folder)).rejects.toThrow('no demo')
  await markDemo(folder, { version: demoVersion, complete: true })
  await stopDemo(folder)
  expect(await readdir(folder)).toContain('quit-mark')
  expect((await checkDemoHome(folder))?.complete).toBe(true)
})

test('withDemoEnvironment uses the demo stubs and then restores the caller’s environment', async () => {
  const before = { ...process.env }
  process.env.TED_CODEX_BIN = '/usr/local/bin/codex'
  process.env.TED_CLAUDE_BIN = '/usr/local/bin/claude'
  delete process.env.TED_KEYRING_MODULE
  process.env.CODEX_HOME = path.join(homedir(), '.codex')
  try {
    const inside = await withDemoEnvironment(folder, async () => ({ ...process.env }))
    expect(inside).toMatchObject({
      TED_HOME: folder,
      TED_DEMO: '1',
      TED_CODEX_BIN: path.join(folder, 'bin', 'stub-codex.mjs'),
      TED_CLAUDE_BIN: path.join(folder, 'bin', 'stub-claude.mjs'),
      TED_GH_BIN: path.join(folder, 'bin', 'stub-gh.mjs'),
    })
    expect(inside.TED_KEYRING_MODULE).toContain('stub-keyring')
    expect(inside.CODEX_HOME).toBeUndefined()
    expect(process.env.TED_CODEX_BIN).toBe('/usr/local/bin/codex')
    await expect(
      withDemoEnvironment(folder, async () => {
        throw new Error('seed failed')
      }),
    ).rejects.toThrow('seed failed')
    expect(process.env.TED_CLAUDE_BIN).toBe('/usr/local/bin/claude')
    expect(process.env.TED_HOME).toBe(before.TED_HOME)
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, before)
  }
})
