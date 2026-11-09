import { execFile } from 'node:child_process'
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { tedPaths } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type CommandLineOptions, createCommandLine } from '../src/command-line.ts'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { api, makeTempHome } from './helpers.ts'

const run = promisify(execFile)

let dir: string
let cleanup: () => Promise<void>

beforeEach(async () => {
  ;({ home: dir, cleanup } = await makeTempHome())
  dir = await realpath(dir)
})

afterEach(async () => {
  await cleanup()
})

async function packagedCopy(
  resources: string,
): Promise<{ appRoot: string; cliPath: string; edition: 'release' }> {
  const appRoot = path.join(resources, 'app')
  const cliPath = path.join(appRoot, 'packages', 'cli', 'src', 'main.js')
  await mkdir(path.dirname(cliPath), { recursive: true })
  await writeFile(
    cliPath,
    'console.log(JSON.stringify({ argv: process.argv.slice(2), app: process.env.TED_APP_EXECUTABLE }))\n',
  )
  await mkdir(path.join(resources, 'bin'))
  await writeFile(path.join(resources, 'bin', 'ted'), '#!/bin/sh\n', { mode: 0o755 })
  return { appRoot, cliPath, edition: 'release' }
}

describe('installing the ted command on macOS', () => {
  let options: CommandLineOptions
  let source: string
  let target: string
  let adminCalls: [string, string][]

  beforeEach(async () => {
    const resources = path.join(dir, 'TED.app', 'Contents', 'Resources')
    const copy = await packagedCopy(resources)
    source = path.join(resources, 'bin', 'ted')
    const systemBinDir = path.join(dir, 'usr-local-bin')
    target = path.join(systemBinDir, 'ted')
    adminCalls = []
    options = {
      platform: 'darwin',
      ...copy,
      env: {},
      homeDir: path.join(dir, 'home'),
      systemBinDir,
      loginPath: async () => '/usr/bin:/bin',
      runAsAdmin: async (from, to) => {
        adminCalls.push([from, to])
        await mkdir(path.dirname(to), { recursive: true })
        await symlink(from, to)
        return 'done'
      },
    }
  })

  test('links /usr/local/bin/ted to the command inside the app', async () => {
    await mkdir(options.systemBinDir as string)
    const commandLine = createCommandLine(options)

    expect(await commandLine.status()).toEqual({ state: 'not-installed', path: target })
    expect(await commandLine.install()).toEqual({ state: 'installed', path: target })
    expect(await readlink(target)).toBe(source)
    expect(adminCalls).toEqual([])
  })

  test('TED Dev never installs a command, so it can’t replace the release’s ted', async () => {
    await mkdir(options.systemBinDir as string)
    const commandLine = createCommandLine({ ...options, edition: 'dev' })

    expect(await commandLine.status()).toEqual({ state: 'unavailable' })
    await expect(commandLine.install()).rejects.toMatchObject({ status: 409 })
    expect(await lstat(target).catch(() => undefined)).toBeUndefined()
    expect(adminCalls).toEqual([])
  })

  test('asks for the admin password only when the folder isn’t writable', async () => {
    const commandLine = createCommandLine(options)

    expect(await commandLine.install()).toEqual({ state: 'installed', path: target })
    expect(adminCalls).toEqual([[source, target]])
  })

  test('cancelling the password prompt leaves it not installed', async () => {
    const commandLine = createCommandLine({ ...options, runAsAdmin: async () => 'cancelled' })

    expect(await commandLine.install()).toEqual({ state: 'not-installed', path: target })
  })

  test('replaces a link to a TED that has moved, but never another program', async () => {
    await mkdir(options.systemBinDir as string)
    await symlink('/Applications/Old/TED.app/Contents/Resources/bin/ted', target)
    const commandLine = createCommandLine(options)

    expect(await commandLine.status()).toEqual({ state: 'not-installed', path: target })
    await commandLine.install()
    expect(await readlink(target)).toBe(source)

    await rm(target)
    await writeFile(target, '#!/bin/sh\necho another ted\n', { mode: 0o755 })
    expect(await commandLine.status()).toEqual({ state: 'taken', path: target })
    await expect(commandLine.install()).rejects.toMatchObject({ status: 409 })
    expect(await readFile(target, 'utf8')).toContain('another ted')
  })

  test('is unavailable when TED runs from source', async () => {
    const commandLine = createCommandLine({ ...options, appRoot: dir })

    expect(await commandLine.status()).toEqual({ state: 'unavailable' })
    await expect(commandLine.install()).rejects.toMatchObject({ status: 409 })
  })
})

describe('the ted command on Linux', () => {
  test('deb and rpm packages install it themselves', async () => {
    const resources = path.join(dir, 'opt', 'TED', 'resources')
    const copy = await packagedCopy(resources)
    await writeFile(path.join(resources, 'package-type'), 'deb')
    const commandLine = createCommandLine({ platform: 'linux', ...copy, env: {} })

    expect(await commandLine.status()).toEqual({ state: 'package' })
    await expect(commandLine.install()).rejects.toMatchObject({ status: 409 })
  })

  describe('from an AppImage', () => {
    let options: CommandLineOptions
    let target: string
    let appDir: string

    beforeEach(async () => {
      appDir = path.join(dir, 'mount')
      const copy = await packagedCopy(path.join(appDir, 'resources'))
      const homeDir = path.join(dir, 'home')
      target = path.join(homeDir, '.local', 'bin', 'ted')
      options = {
        platform: 'linux',
        ...copy,
        env: { APPIMAGE: process.execPath, APPDIR: appDir },
        homeDir,
        loginPath: async () => `${path.join(homeDir, '.local', 'bin')}:/usr/bin`,
      }
    })

    test('writes a ~/.local/bin/ted script that runs the AppImage’s ted', async () => {
      const commandLine = createCommandLine(options)

      expect(await commandLine.status()).toEqual({ state: 'not-installed', path: target })
      expect(await commandLine.install()).toEqual({ state: 'installed', path: target })
      expect((await lstat(target)).mode & 0o777).toBe(0o755)

      const { stdout } = await run(target, ['task', 'list'], {
        env: { ...process.env, APPDIR: appDir },
      })
      expect(JSON.parse(stdout)).toEqual({ argv: ['task', 'list'], app: process.execPath })
    })

    test('shows the line to add when ~/.local/bin isn’t on the login shell’s PATH', async () => {
      const commandLine = createCommandLine({ ...options, loginPath: async () => '/usr/bin:/bin' })

      expect(await commandLine.install()).toEqual({
        state: 'installed',
        path: target,
        addToPath: 'export PATH="$HOME/.local/bin:$PATH"',
      })
    })

    test('rewrites its own script for the AppImage now running, and leaves others alone', async () => {
      await createCommandLine({
        ...options,
        env: { ...options.env, APPIMAGE: '/old/TED.AppImage' },
      }).install()

      await createCommandLine(options).refresh()
      expect(await readFile(target, 'utf8')).toContain(process.execPath)
      expect(await readFile(target, 'utf8')).not.toContain('/old/TED.AppImage')

      await writeFile(target, '#!/bin/sh\necho mine\n')
      await createCommandLine(options).refresh()
      expect(await readFile(target, 'utf8')).toBe('#!/bin/sh\necho mine\n')
      expect(await createCommandLine(options).status()).toEqual({ state: 'taken', path: target })
    })

    test('refresh does nothing when the command was never installed', async () => {
      await createCommandLine(options).refresh()

      await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })
})

describe('the command line over HTTP', () => {
  let daemon: RunningDaemon | undefined

  afterEach(async () => {
    await daemon?.stop()
    daemon = undefined
  })

  test('the app reads and installs the ted command; a Run may not', async () => {
    const copy = await packagedCopy(path.join(dir, 'TED.app', 'Contents', 'Resources'))
    const systemBinDir = path.join(dir, 'usr-local-bin')
    await mkdir(systemBinDir)
    const home = path.join(dir, 'ted-home')
    daemon = await startDaemon({
      home,
      version: '9.9.9',
      commandLine: { platform: 'darwin', ...copy, env: {}, systemBinDir },
    })
    const app = api(daemon.port, { appKey: daemon.appToken })
    const target = path.join(systemBinDir, 'ted')

    expect(await app.call('GET', '/command-line')).toEqual({
      status: 200,
      body: { state: 'not-installed', path: target },
    })
    const runToken = (await loadRunTokens(tedPaths(home).runTokenKey)).issue('run-1')
    const asRun = api(daemon.port, runToken)
    expect((await asRun.call('POST', '/command-line/install')).status).toBe(403)
    expect(await app.call('POST', '/command-line/install')).toEqual({
      status: 200,
      body: { state: 'installed', path: target },
    })
  })
})
