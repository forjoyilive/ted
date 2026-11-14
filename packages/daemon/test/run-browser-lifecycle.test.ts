import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { TaskApp } from '@ted/protocol'
import { afterEach, expect, test } from 'vitest'
import { createRunBrowsers, type RunBrowsers } from '../src/apps/run-browser.ts'
import { waitUntil } from './helpers.ts'

let scratch: string | undefined
let browsers: RunBrowsers | undefined

afterEach(async () => {
  browsers?.closeAll()
  browsers = undefined
  if (scratch) await rm(scratch, { recursive: true, force: true })
  scratch = undefined
})

const web: TaskApp = {
  repo: 'widgets',
  name: 'Web',
  kind: 'web',
  state: 'running',
  url: 'http://localhost:4100/',
  startedAt: '2026-11-14T00:00:00.000Z',
} as TaskApp

test('an App that stops while the browser starts or opens it closes the browser', async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-run-browser-lifecycle-'))
  const helper = path.join(scratch, 'fake-electron.sh')
  await writeFile(helper, `#!/bin/sh\necho '{"id":"ready"}'\nexec sleep 60\n`)
  await chmod(helper, 0o755)
  const dir = path.join(scratch, 'browsers')
  browsers = createRunBrowsers({
    dir,
    env: () => ({ ...process.env, TED_ELECTRON_BIN: helper }),
    lowPriority: () => false,
  })
  const profiles = () => readdir(dir).catch(() => [] as string[])

  const starting = browsers.command('run-1', web, { action: 'open', app: { name: 'Web' } })
  expect(browsers.opened('run-1')).toEqual({ name: 'Web', repo: 'widgets' })
  browsers.appsChanged('run-1', [{ ...web, state: 'stopped' }])
  await expect(starting).rejects.toThrow('The Run’s browser closed')
  expect(browsers.opened('run-1')).toBeUndefined()

  const opening = browsers.command('run-2', web, { action: 'open', app: { name: 'Web' } })
  await waitUntil(async () => ((await profiles()).length === 1 ? true : undefined), 'the helper')
  browsers.appsChanged('run-2', [{ ...web, startedAt: '2026-11-14T00:01:00.000Z' }])
  await expect(opening).rejects.toThrow('The Run’s browser closed')
  expect(browsers.opened('run-2')).toBeUndefined()
  await waitUntil(async () => ((await profiles()).length === 0 ? true : undefined), 'the profile')
})
