import { expect, test } from 'vitest'
import { appWaitLine } from '../src/app-wait.ts'

const slotTaken =
  'Every simulator and emulator slot is taken, so Ted asked the human which one to shut down. Waiting for an answer…'

test('ted run-app says the human was asked only while Ted is still asking', () => {
  const iPhone = { name: 'iPhone', state: 'waiting', kind: 'ios-simulator' } as const
  expect(appWaitLine({ ...iPhone, asking: true }, false)).toBe(slotTaken)
  expect(appWaitLine({ ...iPhone, waitingOn: { displayId: 'NB-2', app: 'Watch' } }, false)).toBe(
    'Waiting for NB-2’s Watch to finish building…',
  )
  expect(appWaitLine(iPhone, false)).toBeUndefined()
  expect(appWaitLine({ ...iPhone, state: 'starting' }, false)).toBeUndefined()
})

test('an Automation Run waits for a slot without asking', () => {
  expect(appWaitLine({ name: 'Pixel', state: 'waiting', kind: 'android-emulator' }, true)).toBe(
    'Waiting for an emulator slot to free up…',
  )
})

test('ted run-app waits for a phone App to finish building and launch', () => {
  const iPhone = {
    name: 'iPhone',
    state: 'running',
    kind: 'ios-simulator',
    simulator: { device: 'iPhone 17', booted: true },
  } as const
  expect(appWaitLine(iPhone, false)).toBe(
    'Waiting for iPhone to finish building and launch on iPhone 17…',
  )
  expect(appWaitLine({ ...iPhone, builtAt: '2026-11-19T10:00:00.000Z' }, false)).toBeUndefined()
  expect(appWaitLine({ ...iPhone, notReady: true }, false)).toBeUndefined()
  expect(appWaitLine({ name: 'Site', state: 'running', kind: 'web' }, false)).toBeUndefined()
})
