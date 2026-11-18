import { expect, test } from 'vitest'
import { appWaitLine } from '../src/app-wait.ts'

const slotTaken =
  'Every simulator and emulator slot is taken, so Ted asked the human which one to shut down. Waiting for an answer…'

test('ted run-app says the human was asked only while Ted is still asking', () => {
  const iPhone = { state: 'waiting', kind: 'ios-simulator' } as const
  expect(appWaitLine({ ...iPhone, asking: true }, false)).toBe(slotTaken)
  expect(appWaitLine({ ...iPhone, waitingOn: { displayId: 'NB-2', app: 'Watch' } }, false)).toBe(
    'Waiting for NB-2’s Watch to finish building…',
  )
  expect(appWaitLine(iPhone, false)).toBeUndefined()
  expect(appWaitLine({ ...iPhone, state: 'starting' }, false)).toBeUndefined()
})

test('an Automation Run waits for a slot without asking', () => {
  expect(appWaitLine({ state: 'waiting', kind: 'android-emulator' }, true)).toBe(
    'Waiting for an emulator slot to free up…',
  )
})
