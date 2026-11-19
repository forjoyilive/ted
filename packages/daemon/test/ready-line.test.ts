import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { logSize, type ReadyRead, readyFromLaunch, readyLineSince } from '../src/apps/ready-line.ts'

let dir: string
let log: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'ted-ready-line-'))
  log = path.join(dir, 'app.log')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('a ready line from an earlier launch never counts for the next one, and a line split across reads still does', async () => {
  await writeFile(log, 'building\nTED_APP_READY\n')
  let read: ReadyRead = readyFromLaunch(await logSize(log))
  const next = async () => {
    const said = await readyLineSince(log, read)
    read = said.read
    return said.ready
  }

  expect(await next()).toBe(false)
  await appendFile(log, 'building again\n')
  expect(await next()).toBe(false)
  await appendFile(log, 'TED_APP_RE')
  expect(await next()).toBe(false)
  await appendFile(log, 'ADY\n')
  expect(await next()).toBe(true)
})

test('after a restart the launch offset is read again, so a ready line printed meanwhile counts', async () => {
  await writeFile(log, 'TED_APP_READY\n')
  const launch = await logSize(log)
  await appendFile(log, 'building\nTED_APP_READY\n')
  expect((await readyLineSince(log, readyFromLaunch(launch))).ready).toBe(true)
  expect((await readyLineSince(log, readyFromLaunch(await logSize(log)))).ready).toBe(false)
})

test('a log that shrank is read from its start', async () => {
  await writeFile(log, 'TED_APP_READY\n')
  expect((await readyLineSince(log, readyFromLaunch(500))).ready).toBe(true)
})
