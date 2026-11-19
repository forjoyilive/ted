import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Banner, CheckTry, CheckTryOutput, Factory, FactorySettingsView } from '@ted/protocol'
import type { JsonObject } from '@ted/protocol/parse'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  commitToOrigin,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'
import { skipInsideTedSandbox } from './support/ted-sandbox.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let daemon: RunningDaemon | undefined
const savedSandbox = process.env.TED_SANDBOX_BIN

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'ted-try-sandbox-')))
  origin = await makeOriginRepo(scratch)
  await commitToOrigin(scratch, {
    '.ted/workflow.yaml': [
      'version: 1',
      'repos:',
      '  - name: widgets',
      '    worktree:',
      '      setup: echo set-up >> setup.log',
      '',
    ].join('\n'),
    '.gitignore': 'setup.log\nfrom-check\n',
  })
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  if (savedSandbox === undefined) delete process.env.TED_SANDBOX_BIN
  else process.env.TED_SANDBOX_BIN = savedSandbox
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function start() {
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: JsonObject): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  const factory = await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const id = factory.id
  const tryCheck = async (name: string, run: string) => {
    const started = await ok<CheckTry>('POST', `/factories/${id}/checks/try`, { name, run })
    const done = await waitUntil(
      async () => {
        const view = await ok<FactorySettingsView>('GET', `/factories/${id}/settings`)
        return view.tries.find(
          (t) => t.name === name && t.startedAt === started.startedAt && t.state !== 'running',
        )
      },
      `Run now of ${name}`,
      20_000,
    )
    const output = await ok<CheckTryOutput>(
      'GET',
      `/factories/${id}/checks/try/output?name=${encodeURIComponent(name)}`,
    )
    return { ...done, output: output.text }
  }
  return { ok, id, tryCheck }
}

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  )

test('with no sandbox, Run now runs neither setup nor the Check, says why and raises the sandbox banner', async () => {
  process.env.TED_SANDBOX_BIN = path.join(home, 'no-such-sandbox')
  const { ok, tryCheck } = await start()
  const marker = path.join(scratch, 'ran')
  const result = await tryCheck('Probe', `touch '${marker}'`)
  expect(result).toMatchObject({ state: 'failed', setupFailed: true })
  expect(result.output).toContain('can’t sandbox')
  expect(await exists(marker)).toBe(false)
  const banners = await ok<Banner[]>('GET', '/banners')
  expect(banners.some((b) => b.problem === 'sandbox-unavailable')).toBe(true)
})

test('a Bypass Factory’s Run now runs without the sandbox', async () => {
  process.env.TED_SANDBOX_BIN = path.join(home, 'no-such-sandbox')
  const { ok, id, tryCheck } = await start()
  await ok('PUT', `/factories/${id}/permissions`, { mode: 'bypass', confirmBypass: true })
  const marker = path.join(scratch, 'ran')
  const result = await tryCheck('Probe', `cat setup.log && touch '${marker}'`)
  expect(result.state).toBe('passed')
  expect(result.output).toContain('set-up')
  expect(await exists(marker)).toBe(true)
})

test.runIf(process.platform === 'darwin')(
  'Run now’s setup and Check write only the scratch worktree and their cache',
  async (context) => {
    skipInsideTedSandbox(context)
    process.env.TED_SANDBOX_BIN = '/usr/bin/sandbox-exec'
    const { tryCheck } = await start()
    const outside = path.join(home, 'escaped')
    const secret = path.join(home, 'private-secret')
    await writeFile(secret, 'secret')
    const result = await tryCheck(
      'Probe',
      [
        `if echo escaped > '${outside}'; then exit 90; fi`,
        `if cat '${secret}'; then exit 91; fi`,
        'mkdir -p "$npm_config_cache"',
        'echo cached > "$npm_config_cache/from-check"',
        'cat setup.log',
        'echo inside > from-check',
      ].join('; '),
    )
    expect(result.output).toContain('set-up')
    expect(result).toMatchObject({ state: 'passed', exitCode: 0 })
    expect(await exists(outside)).toBe(false)
    const cache = path.join(home, 'scratch', result.factoryId, 'sandbox', 'cache')
    expect(await readFile(path.join(cache, 'npm', 'from-check'), 'utf8')).toBe('cached\n')
  },
)
