import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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

test('a run of 10 or more files gets 6 workers and a smaller one 3', async () => {
  const { workersFor } = await import('../../../vitest.config.ts')
  const files = Array.from(
    { length: 12 },
    (_, i) => `packages/daemon/test/file-${i}.test.ts`,
  ).concat('packages/app/test/board.test.ts')
  expect(workersFor(['run'], files)).toBe(6)
  expect(workersFor(['run', 'packages/daemon/test'], files)).toBe(6)
  expect(workersFor(['run', 'packages/daemon/test/file-1.test.ts'], files)).toBe(3)
  expect(workersFor(['run', 'packages/app/test', '--reporter', 'verbose'], files)).toBe(3)
  expect(workersFor(['run', '-t', 'packages/daemon', 'board'], files)).toBe(3)
  expect(
    workersFor(['run', ...files.slice(0, 9), '--reporter=verbose', '--project', 'node'], files),
  ).toBe(3)
  expect(workersFor(['run', ...files.slice(0, 10)], files)).toBe(6)
})

test('a full run puts projects with different worker limits in separate execution groups', async () => {
  const root = (await resolveConfig({ root: repo, watch: false, maxWorkers: 6 })).test
  const workersByGroup = new Map<number, number | string | undefined>()
  const names: string[] = []
  for (const project of root.projects ?? []) {
    if (typeof project !== 'object' || !('test' in project)) continue
    const options = project.test
    const group = options?.sequence?.groupOrder ?? root.sequence?.groupOrder ?? 0
    const workers = options?.maxWorkers ?? root.maxWorkers
    if (workersByGroup.has(group)) expect(workers).toBe(workersByGroup.get(group))
    workersByGroup.set(group, workers)
    if (options?.name) names.push(options.name)
  }
  expect(names).toEqual(expect.arrayContaining(['electron', 'node']))
})

test('TSX component tests are discovered from the repo and app, and Electron imports are followed through TSX helpers', async () => {
  const { launchesElectron } = await import('../../../vitest.config.ts')
  const root = (await resolveConfig({ root: repo, watch: false })).test
  const app = (await resolveConfig({ root: path.join(repo, 'packages/app'), watch: false })).test
  expect(root.projects).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        test: expect.objectContaining({
          name: 'node',
          include: expect.arrayContaining(['packages/*/test/**/*.test.{ts,tsx}']),
        }),
      }),
    ]),
  )
  expect([3, 6]).toContain(root.maxWorkers)
  expect(root.projects).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        test: expect.objectContaining({ name: 'electron', maxWorkers: 3 }),
      }),
    ]),
  )
  expect(app.include).toContain('test/**/*.test.{ts,tsx}')
  expect(launchesElectron(path.join(repo, 'packages/daemon/test/add-factory.test.ts'))).toBe(false)
  expect(launchesElectron(path.join(repo, 'packages/daemon/src/command-env.ts'))).toBe(false)
  expect(launchesElectron(path.join(repo, 'packages/app/test/electron-installation.test.ts'))).toBe(
    false,
  )
  expect(
    launchesElectron(path.join(repo, 'packages/app/test/daemon-client-transport.test.ts')),
  ).toBe(true)
  expect(launchesElectron(path.join(repo, 'packages/app/test/app-inbox.test.ts'))).toBe(true)
  const dir = await mkdtemp(path.join(tmpdir(), 'ted-test-discovery-'))
  try {
    const entry = path.join(dir, 'entry.test.tsx')
    const helper = path.join(dir, 'helper.tsx')
    await writeFile(entry, `import { launch } from '${'./' + 'helper.tsx'}'\n`)
    await writeFile(helper, `import { ${['_', 'electron'].join('')} } from 'playwright'\n`)
    expect(launchesElectron(entry)).toBe(true)
    await writeFile(helper, 'export const launch = () => null\n')
    expect(launchesElectron(entry)).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
