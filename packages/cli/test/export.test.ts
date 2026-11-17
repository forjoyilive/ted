import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { DaemonClient, readDaemonInfo } from '@ted/protocol'
import { expect, test } from 'vitest'
import { startDaemon } from '../../daemon/src/index.ts'
import { loadRunTokens } from '../../daemon/src/run-token.ts'
import { api, makeOriginRepo } from '../../daemon/test/helpers.ts'

const run = promisify(execFile)
const cli = fileURLToPath(new URL('../src/main.ts', import.meta.url))

function environment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TED_HOME: home }
  for (const key of ['TED_RUN_CAPABILITY', 'TED_RUN_TOKEN', 'TED_RUN', 'TED_TASK', 'TED_PLAN'])
    delete env[key]
  return env
}

test('ted export writes either format, defaults to JSON, refuses replacement and denies Run callers', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'ted-cli-export-'))
  const daemon = await startDaemon({ home, version: 'test' })
  try {
    const info = await readDaemonInfo(home)
    if (!info) throw new Error('No daemon info')
    const client = new DaemonClient(info, '', { appKey: daemon.appToken })
    const origin = await makeOriginRepo(home)
    const added = await api(daemon.port, { appKey: daemon.appToken }).call(
      'POST',
      '/dev/factories',
      { repo: origin, key: 'NB' },
    )
    expect(added.status).toBe(201)
    await client.createTask({ title: 'Portable Task', factory: 'NB' })
    const invoke = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
      run(process.execPath, [cli, 'export', ...args], {
        env: { ...environment(home), ...extra },
        cwd: home,
      })
    const destination = path.join(home, 'export.json')
    expect((await invoke(['--factory', 'NB', '--output', destination])).stdout).toContain(
      'Exported 1 Task',
    )
    expect(JSON.parse(await readFile(destination, 'utf8')).tasks[0].title).toBe('Portable Task')
    await expect(invoke(['--factory', 'NB', '--output', destination])).rejects.toThrow(
      'already exists',
    )
    expect(JSON.parse(await readFile(destination, 'utf8')).tasks).toHaveLength(1)
    await invoke(['--factory', 'NB', '--format', 'markdown', '--output', 'export.md'])
    expect(await readFile(path.join(home, 'export.md'), 'utf8')).toContain('Portable Task')
    const tokens = await loadRunTokens(path.join(home, 'run-token.key'))
    await expect(
      invoke(['--factory', 'NB', '--output', 'denied.json'], {
        TED_RUN_CAPABILITY: tokens.issue('test-run'),
      }),
    ).rejects.toThrow()
    expect(await readdir(home)).not.toContain('denied.json')
  } finally {
    await daemon.stop()
    await rm(home, { recursive: true, force: true })
  }
})

test('invalid export arguments fail before starting Ted', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'ted-cli-export-args-'))
  try {
    for (const args of [
      [],
      ['--factory', 'NB'],
      ['--format', 'xml', '--factory', 'NB', '--output', 'x'],
    ]) {
      await expect(
        run(process.execPath, [cli, 'export', ...args], { env: environment(home) }),
      ).rejects.toThrow()
    }
    expect(await readdir(home)).toEqual([])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
