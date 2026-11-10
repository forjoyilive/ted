import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import type { RunningDaemon } from '../src/index.ts'

let daemon: RunningDaemon | undefined
let scratch: string | undefined

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  vi.unstubAllEnvs()
  vi.doUnmock('../../protocol/src/edition.ts')
  vi.doUnmock('../src/cli-env.ts')
  vi.resetModules()
  if (scratch) await rm(scratch, { recursive: true, force: true })
  scratch = undefined
})

test.each(['release', 'dev'] as const)(
  '%s daemon handles the keyring test hook by edition',
  async (edition) => {
    scratch = await mkdtemp(path.join(tmpdir(), 'ted-release-env-'))
    const marker = path.join(scratch, 'imported')
    const module = path.join(scratch, 'keyring.mjs')
    await writeFile(
      module,
      `
    import { writeFileSync } from 'node:fs'
    writeFileSync(${JSON.stringify(marker)}, 'imported')
    throw new Error('test keyring module executed')
  `,
    )
    vi.stubEnv('TED_KEYRING_MODULE', module)
    vi.resetModules()
    vi.doMock('../../protocol/src/edition.ts', async (original) => ({
      ...(await original<typeof import('../../protocol/src/edition.ts')>()),
      edition,
    }))
    const { startDaemon } = await import('../src/index.ts')
    const starting = startDaemon({
      home: path.join(scratch, 'home'),
      version: '9.9.9',
      online: { isOnline: async () => true },
      disk: {
        freeBytes: async () => 500e9,
        excludeFromBackups: async () => undefined,
      },
    })
    if (edition === 'dev') {
      await expect(starting).rejects.toThrow('test keyring module executed')
      expect(await readFile(marker, 'utf8')).toBe('imported')
    } else {
      daemon = await starting
      const { DaemonClient, readDaemonInfo } = await import('@ted/protocol')
      const info = await readDaemonInfo(path.join(scratch, 'home'))
      if (!info) throw new Error('daemon did not write its connection information')
      const client = new DaemonClient(info)
      expect(await client.listTasks()).toEqual([])
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  },
)

test.each(['release', 'dev'] as const)(
  '%s filters environment capture and login-shell reloads',
  async (edition) => {
    vi.resetModules()
    vi.doMock('../../protocol/src/edition.ts', async (original) => ({
      ...(await original<typeof import('../../protocol/src/edition.ts')>()),
      edition,
    }))
    vi.doMock('../src/cli-env.ts', async (original) => ({
      ...(await original<typeof import('../src/cli-env.ts')>()),
      readLoginEnv: async () => ({
        PATH: '/shell/bin',
        TED_KEYRING_MODULE: '/from/shell',
        TED_NEW_HOOK: 'shell',
      }),
    }))
    const { createEnvironment } = await import('../src/command-env.ts')
    const base = { PATH: '/base/bin', TED_HOME: '/task/home', TED_NEW_HOOK: 'base' }
    const environment = createEnvironment({ base, loginShell: true })
    expect(environment.current()).toEqual(
      edition === 'dev' ? base : { PATH: '/base/bin', TED_HOME: '/task/home' },
    )
    const reloaded = await environment.reload()
    expect(reloaded).toEqual(
      edition === 'dev'
        ? { PATH: '/shell/bin', TED_KEYRING_MODULE: '/from/shell', TED_NEW_HOOK: 'shell' }
        : { PATH: '/shell/bin' },
    )
    expect(environment.current()).toBe(reloaded)
    expect(base.TED_NEW_HOOK).toBe('base')
  },
)
