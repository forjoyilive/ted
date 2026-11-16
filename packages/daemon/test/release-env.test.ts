import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createEnvironment } from '../src/command-env.ts'
import { loadKeyring } from '../src/linear/keyring.ts'

let scratch: string | undefined

afterEach(async () => {
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
    const loading = loadKeyring({ TED_KEYRING_MODULE: module }, 'darwin', undefined, edition)
    if (edition === 'dev') {
      await expect(loading).rejects.toThrow('test keyring module executed')
      expect(await readFile(marker, 'utf8')).toBe('imported')
    } else {
      expect((await loading).kind).toBe('macos-keychain')
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  },
)

test.each(['release', 'dev'] as const)(
  '%s filters environment capture and login-shell reloads',
  async (edition) => {
    const base = { PATH: '/base/bin', TED_HOME: '/task/home', TED_NEW_HOOK: 'base' }
    const environment = createEnvironment({
      base,
      loginShell: true,
      edition,
      readLoginEnv: async () => ({
        PATH: '/shell/bin',
        TED_KEYRING_MODULE: '/from/shell',
        TED_NEW_HOOK: 'shell',
      }),
    })
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
