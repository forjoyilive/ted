import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type AndroidResult, type AndroidTools, createEmulators } from '../src/apps/emulators.ts'
import type { TedStore } from '../src/store/index.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-emus-unit-'))
  await writeFile(
    path.join(dir, 'devices.json'),
    JSON.stringify({
      't1/widgets/android': {
        avd: 'TED_Dev_NB-1_widgets_android',
        taskId: 't1',
        repo: 'widgets',
        name: 'android',
        device: 'Pixel_8_API_35',
        serial: 'emulator-5554',
        lastUsedAt: '2026-11-14T10:00:00Z',
      },
    }),
  )
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const result = (code: number, stdout = '', stderr = ''): AndroidResult => ({
  code,
  stdout,
  stderr,
  bytes: Buffer.from(stdout),
})

function fakeTools(answers: { avdName: AndroidResult; delete: () => AndroidResult }) {
  const calls: string[] = []
  const tools: AndroidTools = {
    async adb(args) {
      calls.push(`adb ${args.join(' ')}`)
      if (args[0] === 'devices')
        return result(0, 'List of devices attached\nemulator-5554\tdevice\n')
      if (args.slice(2).join(' ') === 'emu avd name') return answers.avdName
      return result(0, 'OK')
    },
    async avdmanager(args) {
      calls.push(`avdmanager ${args.join(' ')}`)
      return args[0] === 'delete' ? answers.delete() : result(0)
    },
    async emulator(args) {
      calls.push(`emulator ${args.join(' ')}`)
      return result(0)
    },
    launch() {
      throw new Error('no launches in this test')
    },
  }
  return { tools, calls }
}

function emulators(tools: AndroidTools) {
  return createEmulators({
    dir,
    store: {
      settings: () => ({ maxRunningEmulators: 2 }),
      getTask: () => undefined,
    } as unknown as TedStore,
    tools,
    supported: true,
    emit() {},
    appLive: async () => false,
    stopApp: async () => {},
    pollMs: 60_000,
  })
}

test('TED never kills an emulator running another AVD, and keeps a record until its AVD is deleted', async () => {
  let deletes = 0
  const { tools, calls } = fakeTools({
    avdName: result(0, 'Someone_Elses_AVD\nOK'),
    delete: () => (++deletes === 1 ? result(1, '', 'Error: the AVD is in use') : result(0)),
  })
  const emus = emulators(tools)

  await emus.remove('t1')
  expect(calls).not.toContain('adb -s emulator-5554 emu kill')
  expect(emus.taskIds()).toEqual(['t1'])

  await emus.remove('t1')
  expect(emus.taskIds()).toEqual([])
  expect(calls.filter((c) => c.startsWith('avdmanager delete'))).toHaveLength(2)
  await emus.close()
})

test('when TED can’t tell which AVD runs on the port, it leaves the emulator and keeps its record', async () => {
  const { tools, calls } = fakeTools({
    avdName: result(1, '', 'error: could not connect'),
    delete: () => result(0),
  })
  const emus = emulators(tools)

  await emus.remove('t1')
  expect(calls).not.toContain('adb -s emulator-5554 emu kill')
  expect(calls.some((c) => c.startsWith('avdmanager delete'))).toBe(false)
  expect(emus.taskIds()).toEqual(['t1'])
  await emus.close()
})
