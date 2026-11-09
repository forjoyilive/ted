import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type Backups, createBackups } from '../src/backups.ts'
import { makeTempHome } from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let now: Date
let backups: Backups

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  now = new Date(2026, 10, 1, 9, 0)
  backups = createBackups({ home, version: '1.0.0', now: () => now })
})

afterEach(async () => {
  await cleanup()
})

const eventlog = (text: string) => ({
  fileName: 'eventlog@6.db',
  data: new TextEncoder().encode(text),
})
const nextDay = () => {
  now = new Date(now.getTime() + 24 * 60 * 60 * 1000)
}

async function addAttachment(hash: string, content: string): Promise<void> {
  await mkdir(path.join(home, 'attachments'), { recursive: true })
  await writeFile(path.join(home, 'attachments', hash), content)
}

describe('daily backups', () => {
  test('takes one backup a day of the event log and keeps the last seven', async () => {
    for (let day = 1; day <= 9; day++) {
      expect(await backups.takeDaily(eventlog(`day ${day}`))).toBeDefined()
      expect(await backups.takeDaily(eventlog(`day ${day} again`))).toBeUndefined()
      nextDay()
    }

    const daily = (await backups.list()).filter((b) => b.kind === 'daily')
    expect(daily.map((b) => b.name)).toEqual([
      'daily-20261109',
      'daily-20261108',
      'daily-20261107',
      'daily-20261106',
      'daily-20261105',
      'daily-20261104',
      'daily-20261103',
    ])
    const newest = path.join(home, 'backups', 'daily-20261109', 'store', 'ted')
    expect(await readFile(path.join(newest, 'eventlog@6.db'), 'utf8')).toBe('day 9')
    expect(daily[0]).toMatchObject({
      dataFrom: '1.0.0',
      takenAt: new Date(2026, 10, 9, 9).toISOString(),
    })
  })

  test('copies each attachment file once, by hash, and drops ones no backup lists', async () => {
    await addAttachment('aaa', 'first file')
    await backups.takeDaily(eventlog('one'))
    const copy = path.join(home, 'backups', 'attachments', 'aaa')
    const firstCopy = await stat(copy)

    nextDay()
    await addAttachment('bbb', 'second file')
    await backups.takeDaily(eventlog('two'))

    expect((await stat(copy)).ino).toBe(firstCopy.ino)
    expect((await stat(copy)).mtimeMs).toBe(firstCopy.mtimeMs)
    expect(await readFile(path.join(home, 'backups', 'attachments', 'bbb'), 'utf8')).toBe(
      'second file',
    )
    expect(await readdir(path.join(home, 'backups'))).not.toContain('aaa')

    await rm(path.join(home, 'attachments', 'aaa'))
    for (let day = 0; day < 7; day++) {
      nextDay()
      await backups.takeDaily(eventlog('later'))
    }
    expect(await readdir(path.join(home, 'backups', 'attachments'))).toEqual(['bbb'])
  })

  test('a failure names the reason in plain words', async () => {
    await writeFile(path.join(home, 'backups'), 'not a folder')

    await expect(backups.takeDaily(eventlog('one'))).rejects.toThrow(
      `${path.join(home, 'backups')} isn’t a folder`,
    )
  })
})
