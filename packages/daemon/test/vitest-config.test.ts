import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { resolveConfig } from 'vitest/node'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const stubGh = path.join(repo, 'packages/daemon/test/fixtures/stub-gh.ts')
const setupFile = path.join(repo, 'packages/daemon/test/support/setup.ts')

const packagesWithTests = async () => {
  const names = await readdir(path.join(repo, 'packages'))
  const found: string[] = []
  for (const name of names) {
    const tests = await readdir(path.join(repo, 'packages', name, 'test')).catch(() => [])
    if (tests.some((file) => file.endsWith('.test.ts'))) found.push(name)
  }
  return found
}

describe('vitest config', () => {
  test('running vitest from the repo or from any package directory uses the stubbed gh, keyring and setup', async () => {
    const roots = [
      repo,
      ...(await packagesWithTests()).map((name) => path.join(repo, 'packages', name)),
    ]
    expect(roots.length).toBeGreaterThan(1)
    for (const root of roots) {
      const config = (await resolveConfig({ root, watch: false })).test
      expect({ root, gh: config?.env?.TED_GH_BIN }).toEqual({ root, gh: stubGh })
      expect(config?.env?.TED_KEYRING_MODULE).toMatch(/stub-keyring\.ts$/)
      expect(config?.env?.TED_APP_TOKEN).toBe('test-app-token')
      expect(config?.setupFiles).toContain(setupFile)
      expect(config?.testTimeout).toBe(30_000)
    }
  }, 60_000)
})
