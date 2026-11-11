import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, test } from 'vitest'
import { prepareElectron, resolveElectron } from './support/electron-installation.ts'

const execute = promisify(execFile)
const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

async function installation() {
  const home = await mkdtemp(path.join(tmpdir(), 'ted-electron-install-'))
  homes.push(home)
  await writeFile(path.join(home, 'package.json'), JSON.stringify({ version: '1.0.0' }))
  await writeFile(
    path.join(home, 'install.js'),
    `const fs = require('node:fs'); const path = require('node:path');
    fs.appendFileSync(path.join(__dirname, 'attempts'), 'install\\n');
    setTimeout(() => {
      fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(__dirname, 'dist', 'version'), '1.0.0');
      fs.writeFileSync(path.join(__dirname, 'dist', 'electron'), '', { mode: 0o755 });
      fs.writeFileSync(path.join(__dirname, 'path.txt'), 'electron');
    }, 100);`,
  )
  return home
}

test('prepares a missing installation once before readers use it', async () => {
  const home = await installation()
  expect(() => resolveElectron(home)).toThrow(/Electron.*not ready/)
  await Promise.all([prepareElectron(home), prepareElectron(home)])
  expect(resolveElectron(home)).toBe(path.join(home, 'dist', 'electron'))
  await prepareElectron(home)
  expect(await readFile(path.join(home, 'attempts'), 'utf8')).toBe('install\n')
})

test('readers reject a vanished executable without starting an installer', async () => {
  const home = await installation()
  await prepareElectron(home)
  await rm(path.join(home, 'dist', 'electron'))
  expect(() => resolveElectron(home)).toThrow(/Electron.*not ready/)
  expect(await readFile(path.join(home, 'attempts'), 'utf8')).toBe('install\n')
})

test.each([0, 7])(
  'an installer exiting %s without a ready executable rejects preparation',
  async (code) => {
    const home = await installation()
    await writeFile(
      path.join(home, 'install.js'),
      `console.error('fixture installation failed'); process.exit(${code})`,
    )
    await expect(prepareElectron(home)).rejects.toThrow(
      /Electron preflight failed.*native tests were not collected/,
    )
    expect(() => resolveElectron(home)).toThrow(/Electron.*not ready/)
  },
)

test('separate processes sharing an installation wait for one preparation', async () => {
  const home = await installation()
  const script = `import { prepareElectron } from ${JSON.stringify(new URL('./support/electron-installation.ts', import.meta.url).href)}; console.log(await prepareElectron(${JSON.stringify(home)}))`
  const results = await Promise.all(
    [0, 1, 2].map(() =>
      execute(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env } }),
    ),
  )
  for (const result of results) expect(result.stdout).toContain(path.join(home, 'dist', 'electron'))
  expect(await readFile(path.join(home, 'attempts'), 'utf8')).toBe('install\n')
})

test('a version mismatch is rejected and prepared before readers proceed', async () => {
  const home = await installation()
  await prepareElectron(home)
  await writeFile(path.join(home, 'dist', 'version'), '0.9.0')
  expect(() => resolveElectron(home)).toThrow(/Electron.*not ready/)
  await prepareElectron(home)
  expect(resolveElectron(home)).toBe(path.join(home, 'dist', 'electron'))
})

test.each(['ready', 'failed'])(
  'native collection with %s preparation cannot silently pass without assertions',
  async (state) => {
    const home = await installation()
    if (state === 'failed') await writeFile(path.join(home, 'install.js'), 'process.exit(7)')
    const vitest = fileURLToPath(
      new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url),
    )
    const vitestApi = path.join(path.dirname(vitest), 'dist/index.js')
    const helper = fileURLToPath(new URL('./support/electron-installation.ts', import.meta.url))
    await writeFile(
      path.join(home, 'setup.ts'),
      `import { prepareElectron } from ${JSON.stringify(helper)}; export default async () => { await prepareElectron(${JSON.stringify(home)}) }`,
    )
    await writeFile(
      path.join(home, 'native.test.ts'),
      `import { test, expect } from ${JSON.stringify(vitestApi)}; import { resolveElectron } from ${JSON.stringify(helper)}; const executable = resolveElectron(${JSON.stringify(home)}); test('retained native main path', () => expect(executable).toBe(${JSON.stringify(path.join(home, 'dist', 'electron'))}))`,
    )
    await writeFile(
      path.join(home, 'vitest.config.ts'),
      `export default { test: { root: ${JSON.stringify(home)}, include: ['native.test.ts'], globalSetup: ['./setup.ts'], maxWorkers: 1 } }`,
    )
    const result = await execute(
      process.execPath,
      [vitest, 'run', '--config', path.join(home, 'vitest.config.ts')],
      { env: { ...process.env }, timeout: 30_000 },
    ).then(
      (result) => ({ ok: true, output: result.stdout + result.stderr }),
      (error: { stdout: string; stderr: string }) => ({
        ok: false,
        output: error.stdout + error.stderr,
      }),
    )
    expect(result.ok, result.output).toBe(state === 'ready')
    if (state === 'ready') expect(result.output).toContain('1 passed')
    else expect(result.output).toContain('Electron preflight failed')
  },
)
