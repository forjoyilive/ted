import { execFile } from 'node:child_process'
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { sandboxReasons, skipInsideTedSandbox } from '../../daemon/test/support/ted-sandbox.ts'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../src/main.ts', import.meta.url))
let home: string
beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), 'ted-demo-cli-')))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})
const env = () => ({
  ...process.env,
  TED_HOME: home,
  TED_RUN: '',
  TED_TASK: '',
  TED_PLAN: '',
  TED_RUN_TOKEN: '',
  TED_RUN_CAPABILITY: '',
})

test('lists demo seeding in help', async () => {
  const result = await exec(process.execPath, [cli, 'help'], { env: env() })
  expect(result.stdout).toContain('ted dev seed [--reset]')
  expect(await readdir(home)).toEqual([])
})

test('refuses Run callers before starting a daemon or preparing files', async () => {
  await expect(
    exec(process.execPath, [cli, 'dev', 'seed'], {
      env: { ...env(), TED_RUN_CAPABILITY: 'not-a-real-token' },
    }),
  ).rejects.toMatchObject({ stderr: expect.stringContaining('outside a Run') })
  expect(await readdir(home)).toEqual([])
})

test('refuses to reset an unrecognized nonempty home', async (context) => {
  skipInsideTedSandbox(context, sandboxReasons.tedHome)
  await writeFile(path.join(home, 'keep.txt'), 'Keep this file')
  await expect(
    exec(process.execPath, [cli, 'dev', 'seed', '--reset'], { env: env() }),
  ).rejects.toMatchObject({ stderr: expect.stringContaining('unrecognized') })
  expect(await readdir(home)).toEqual(['keep.txt'])
})
