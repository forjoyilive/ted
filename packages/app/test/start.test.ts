import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, test } from 'vitest'
import { sandboxReasons, skipInsideTedSandbox } from '../../daemon/test/support/ted-sandbox.ts'

const exec = promisify(execFile)
let folder: string | undefined

afterEach(async () => {
  if (folder) await rm(folder, { recursive: true, force: true })
})

test('forwards app and Electron arguments after building the renderer', async (context) => {
  skipInsideTedSandbox(context, sandboxReasons.appStart)
  folder = await mkdtemp(path.join(tmpdir(), 'ted-launcher-'))
  const bin = path.join(folder, 'bin')
  const log = path.join(folder, 'commands.jsonl')
  await mkdir(bin)
  await writeFile(
    path.join(bin, 'pnpm'),
    `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(process.env.TED_LAUNCH_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')\n`,
    { mode: 0o755 },
  )
  const app = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
  await exec(
    process.execPath,
    [path.join(app, 'scripts', 'start.ts'), '--background', '--disable-gpu'],
    {
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        TED_LAUNCH_LOG: log,
      },
    },
  )
  expect(
    (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
  ).toEqual([
    ['exec', 'vite', 'build'],
    ['exec', 'electron', app, '--background', '--disable-gpu'],
  ])
})
