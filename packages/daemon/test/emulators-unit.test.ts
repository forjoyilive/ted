import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  androidSize,
  formatScreen,
  inputText,
  maxScreenElements,
  parseUiDump,
  parseWmSize,
  screenBounds,
} from '../src/apps/android-screen.ts'
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

test('parseUiDump keeps elements with text, a label or a tap target, decoded and on one line', () => {
  const dump = `<?xml version='1.0' ?><hierarchy rotation="0"><node class="android.widget.FrameLayout" text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]"><node class="android.widget.TextView" text="Tom &amp; Jerry&#10;&lt;b&gt;" content-desc="" clickable="false" bounds="[10,20][110,60]" /><node class="android.widget.ImageButton" text="" content-desc="Menu" resource-id="app:id/menu" clickable="true" bounds="[0,0][50,50]" /><node class="android.view.View" text="Hidden" clickable="false" bounds="[5,5][5,9]" /><node class="android.view.View" text="" clickable="true" bounds="[0,0][1,1]" /></node></hierarchy>UI hierchary dumped to: /dev/tty`
  const screen = parseUiDump(dump)
  expect(screen).toEqual({
    width: 1080,
    height: 2400,
    rotation: 0,
    elements: [
      {
        ref: '1',
        kind: 'TextView',
        text: 'Tom & Jerry <b>',
        clickable: false,
        left: 10,
        top: 20,
        right: 110,
        bottom: 60,
      },
      {
        ref: '2',
        kind: 'ImageButton',
        label: 'Menu',
        id: 'app:id/menu',
        clickable: true,
        left: 0,
        top: 0,
        right: 50,
        bottom: 50,
      },
      { ref: '3', kind: 'View', clickable: true, left: 0, top: 0, right: 1, bottom: 1 },
    ],
  })
  expect(parseUiDump('ERROR: could not get idle state.')).toBeUndefined()
})

test('formatScreen fences what the App shows and caps the list', () => {
  const many = Array.from(
    { length: maxScreenElements + 5 },
    (_, i) =>
      `<node class="x.Button" text="B${i}" clickable="true" bounds="[0,${i}][10,${i + 1}]" />`,
  ).join('')
  const screen = parseUiDump(`<hierarchy>${many}</hierarchy>`)
  if (!screen) throw new Error('no screen')
  expect(screen.elements).toHaveLength(maxScreenElements)
  const text = formatScreen('android', screen, 'abc123')
  const lines = text.split('\n')
  expect(lines[2]).toBe('<<<SCREEN abc123>>>')
  expect(lines[3]).toBe('1 Button "B0" clickable at 5,0 bounds 0,0,10,1')
  expect(lines.at(-2)).toBe('<<<END SCREEN abc123>>>')
  expect(lines.at(-1)).toBe(`Only the first ${maxScreenElements} elements are listed.`)
})

test('inputText quotes printable ASCII for the device shell and refuses the rest', () => {
  expect(inputText("it's a $(test); `x`")).toBe("'it'\\''s%sa%s$(test);%s`x`'")
  expect(inputText('line\nbreak')).toBeUndefined()
  expect(inputText('café')).toBeUndefined()
  expect(inputText('foo%sbar')).toBeUndefined()
  expect(inputText('100%')).toBe("'100%'")
})

test('parseWmSize prefers the override and androidSize checks its limits', () => {
  expect(parseWmSize('Physical size: 1080x2400')).toEqual({ width: 1080, height: 2400 })
  expect(parseWmSize('Physical size: 1080x2400\nOverride size: 720x1280')).toEqual({
    width: 720,
    height: 1280,
  })
  expect(screenBounds({ width: 1080, height: 2400 }, 1)).toEqual({ width: 2400, height: 1080 })
  expect(screenBounds({ width: 1080, height: 2400 }, 2)).toEqual({ width: 1080, height: 2400 })
  expect(parseUiDump('<hierarchy rotation="3"></hierarchy>')?.rotation).toBe(3)
  expect(androidSize('720x1280')).toEqual({ width: 720, height: 1280 })
  expect(androidSize('reset')).toBe('reset')
  expect(androidSize('100x1280')).toContain('like 1080x1920')
  expect(androidSize('Pixel 8')).toContain('like 1080x1920')
})
