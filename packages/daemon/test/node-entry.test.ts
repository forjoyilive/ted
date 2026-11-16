import { execFile } from 'node:child_process'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { nodeEntry, shellScript } from '../src/node-entry.ts'
import { makeTempHome } from './helpers.ts'

const run = promisify(execFile)

let dir: string
let cleanup: () => Promise<void>
let entry: string

beforeEach(async () => {
  ;({ home: dir, cleanup } = await makeTempHome())
  dir = await realpath(dir)
  entry = path.join(dir, 'app dir', 'packages', 'cli', 'src', 'main.js')
  await mkdir(path.dirname(entry), { recursive: true })
  await writeFile(
    entry,
    'console.log(JSON.stringify({ argv: process.argv.slice(1), file: import.meta.filename }))\n',
  )
})

afterEach(async () => {
  await cleanup()
})

async function runEntry(env: NodeJS.ProcessEnv, args: string[]) {
  const { command, args: full } = nodeEntry(entry, args, env)
  const { stdout } = await run(command, full, { env: { ...process.env, ...env } })
  return JSON.parse(stdout) as { argv: string[]; file: string }
}

describe('running one of Ted’s own entry files', () => {
  test('runs the file with this runtime and passes the arguments through', async () => {
    const result = await runEntry({}, ['task', '--task', 'NOTE-1', 'it’s "done"'])

    expect(result).toEqual({
      argv: [entry, 'task', '--task', 'NOTE-1', 'it’s "done"'],
      file: entry,
    })
  })

  test('inside an AppImage, goes through the AppImage so the file is found in its own mount', async () => {
    const env = { APPIMAGE: process.execPath, APPDIR: path.join(dir, 'app dir') }

    const { command } = nodeEntry(entry, [], env)
    const result = await runEntry(env, ['--task', 'NOTE-1'])

    expect(command).toBe(process.execPath)
    expect(result).toEqual({ argv: [entry, '--task', 'NOTE-1'], file: entry })
  })

  test('a shell script runs the entry with the script’s arguments and the given variables', async () => {
    const script = path.join(dir, 'ted')
    await writeFile(
      script,
      shellScript(nodeEntry(entry, ['status'], {}), { TED_APP_EXECUTABLE: "/Apps/Ted's.app" }),
      { mode: 0o755 },
    )
    await writeFile(
      entry,
      'console.log(JSON.stringify({ argv: process.argv.slice(2), app: process.env.TED_APP_EXECUTABLE }))\n',
    )

    const { stdout } = await run(script, ['--task', 'a b', "it's"])

    expect(JSON.parse(stdout)).toEqual({
      argv: ['status', '--task', 'a b', "it's"],
      app: "/Apps/Ted's.app",
    })
  })
})
