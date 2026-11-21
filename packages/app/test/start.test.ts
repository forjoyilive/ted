import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, test } from 'vitest'

const exec = promisify(execFile)
let folder: string | undefined

afterEach(async () => {
  if (folder) await rm(folder, { recursive: true, force: true })
})

test('launches sandboxed Electron with the worktree cache and forwarded arguments', async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'ted-launcher-'))
  const bin = path.join(folder, 'bin')
  const log = path.join(folder, 'commands.jsonl')
  await mkdir(bin)
  await writeFile(
    path.join(bin, 'pnpm'),
    `#!/usr/bin/env node
const args = process.argv.slice(2)
const cache = args[1] === 'electron' ? process.env.electron_config_cache : undefined
require('node:fs').appendFileSync(process.env.TED_LAUNCH_LOG, JSON.stringify({ args, cache }) + '\\n')
`,
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
        TED_SANDBOX: '1',
        TED_SANDBOX_ELECTRON: '1',
        TED_LAUNCH_LOG: log,
        electron_config_cache: path.join(folder, 'different-cache'),
      },
    },
  )
  expect(
    (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
  ).toEqual([
    { args: ['exec', 'vite', 'build'] },
    {
      args: ['exec', 'electron', app, '--background', '--disable-gpu'],
      cache: path.resolve(app, '../../node_modules/.cache/electron'),
    },
  ])
})
