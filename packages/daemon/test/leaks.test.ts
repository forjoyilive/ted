import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, test } from 'vitest'
import { findMarked, killMarked } from './support/processes.ts'

const run = promisify(execFile)
const vitest = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url))
const leakyConfig = fileURLToPath(new URL('./fixtures/leaky/vitest.config.ts', import.meta.url))

let nestedRun: string | undefined

afterEach(async () => {
  if (nestedRun) await killMarked('TED_TEST_RUN', nestedRun)
  nestedRun = undefined
})

test('no process a test started outlives the test run', async () => {
  nestedRun = randomUUID()
  await run(process.execPath, [vitest, 'run', '--config', leakyConfig], {
    env: { ...process.env, TED_TEST_RUN_ID: nestedRun },
    timeout: 120_000,
  })
  expect(await findMarked('TED_TEST_RUN', nestedRun)).toEqual([])
}, 150_000)
