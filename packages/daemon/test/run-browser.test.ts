import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Automation, AutomationDetail, Factory } from '@ted/protocol'
import { afterEach, expect, test, vi } from 'vitest'
import { resolveElectron } from '../../app/test/support/electron-installation.ts'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  assistantTexts,
  commitToOrigin,
  killAppHosts,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'

const stubApp = fileURLToPath(new URL('./fixtures/stub-app.ts', import.meta.url))
vi.setConfig({ testTimeout: 120_000 })

let daemon: RunningDaemon | undefined
let done: (() => Promise<void>) | undefined

afterEach(async () => {
  await done?.()
  done = undefined
})

const pngSize = (data: Buffer) => ({ width: data.readUInt32BE(16), height: data.readUInt32BE(20) })

test('an Automation Run drives its web App in a headless browser, at a narrow width and in dark mode, and stays on the App', async () => {
  const { home, cleanup } = await makeTempHome()
  const scratch = await mkdtemp(path.join(tmpdir(), 'ted-run-browser-'))
  process.env.TED_ELECTRON_BIN = resolveElectron()
  done = async () => {
    await daemon?.stop()
    daemon = undefined
    delete process.env.TED_ELECTRON_BIN
    await killAppHosts(home)
    await killRunHosts(home)
    await cleanup()
    await rm(scratch, { recursive: true, force: true })
  }
  const origin = await makeOriginRepo(scratch)
  await commitToOrigin(scratch, {
    '.ted/workflow.yaml': [
      'version: 1',
      'order: [intake, work, merge]',
      'repos:',
      '  - name: widgets',
      '    apps:',
      '      - name: Web',
      '        kind: web',
      `        run: "'${process.execPath}' '${stubApp}'"`,
      '        env:',
      '          STUB_APP_BROWSER: "1"',
    ].join('\n'),
  })
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    apps: { pollMs: 50, readyTimeoutMs: 20_000, stopGraceMs: 3_000 },
  })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const browser = (...args: string[]) => ({ run: ['ted', 'browser', ...args] })
  const automation = await ok<Automation>('POST', '/automations', {
    name: 'Audit',
    factory: 'NB',
    schedule: { kind: 'daily', at: '09:00' },
    on: false,
    checkout: true,
    runNow: true,
    prompt: JSON.stringify({
      steps: [
        { run: ['ted', 'run-app', 'Web'] },
        browser('open', 'Web'),
        browser('navigate', '/pages/one'),
        {
          run: [
            'sh',
            '-c',
            'ted browser click "$(ted browser snapshot | grep " a Next page" | cut -d " " -f 1)"',
          ],
        },
        {
          run: [
            'sh',
            '-c',
            'for i in $(seq 40); do out=$(ted browser snapshot 2>&1) && case "$out" in *"Second page"*) echo "$out"; exit 0;; esac; sleep 0.25; done; echo "$out"; exit 1',
          ],
        },
        browser('resize', '390x844'),
        browser('screenshot'),
        browser('color-scheme', 'dark'),
        browser('screenshot'),
        browser('navigate', 'http://example.com/'),
        { endTurn: true },
      ],
    }),
  })
  const runId = await waitUntil(
    async () =>
      (await ok<AutomationDetail>('GET', `/automations/${automation.id}`)).history.find(
        (r) => r.runId !== undefined,
      )?.runId,
    'the Automation Run',
  )
  const finished = await waitUntil(
    async () =>
      (await ok<AutomationDetail>('GET', `/automations/${automation.id}`)).history.find(
        (r) => r.runId === runId && r.finishedAt !== undefined,
      ),
    'the Automation Run to finish',
    90_000,
  )
  const results = assistantTexts((await client.getRun(runId)).conversation).map(
    (t) => JSON.parse(t) as { code: number; stdout: string; stderr: string },
  )
  expect(results.slice(0, 9).map((r) => [r.code, r.stderr])).toEqual(
    Array.from({ length: 9 }, () => [0, '']),
  )
  expect(results[4]?.stdout).toContain('Second page')
  expect(results[6]?.stdout).toContain('Attach with ted task create --attach')
  expect(results[9]?.code).not.toBe(0)
  expect(results[9]?.stderr).toContain('Navigate within this App’s origin')

  const shots = finished.screenshots ?? []
  expect(shots.map((s) => [s.name, s.mediaType])).toEqual([
    ['Web screenshot.png', 'image/png'],
    ['Web screenshot.png', 'image/png'],
  ])
  expect(shots[0]?.hash).not.toBe(shots[1]?.hash)
  const bytes = await ok<{ data: string }>(
    'GET',
    `/attachments/${shots[0]?.hash}/${encodeURIComponent('Web screenshot.png')}`,
  )
  const { width, height } = pngSize(Buffer.from(bytes.data, 'base64'))
  expect([390, 780]).toContain(width)
  expect(height / width).toBeCloseTo(844 / 390, 1)

  await waitUntil(
    async () =>
      (await stat(path.join(home, 'browsers', runId)).catch(() => undefined)) === undefined
        ? true
        : undefined,
    'the Run’s browser to close',
  )
})
