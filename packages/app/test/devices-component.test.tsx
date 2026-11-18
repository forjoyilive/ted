// @vitest-environment jsdom
import type { SimulatorSlots } from '@ted/protocol'
import { act, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { DevicesPopover } from '../src/renderer/components/DevicesPopover.tsx'
import { appState } from './support/app.tsx'
import { user } from './support/component.ts'

const slots: SimulatorSlots = {
  supported: true,
  limit: 2,
  booted: [
    {
      udid: 'U1',
      taskId: 't1',
      displayId: 'NB-1',
      title: 'Sync notes',
      repo: 'app',
      app: 'iPhone',
      device: 'iPhone 16',
      lastUsedAt: '2026-11-17T10:00:00Z',
      recording: true,
    },
    {
      udid: 'emulator-5554',
      taskId: 't2',
      displayId: 'NB-2',
      title: 'Offline drafts',
      repo: 'app',
      app: 'Android',
      device: 'Pixel 8',
      lastUsedAt: '2026-11-17T10:05:00Z',
      recording: false,
      platform: 'android',
    },
  ],
  waiting: [
    {
      taskId: 't3',
      displayId: 'NB-3',
      title: 'Share sheet',
      repo: 'app',
      app: 'iPhone',
      device: 'iPhone 16 Pro',
      place: 1,
      waitingFor: { kind: 'device' },
    },
    {
      taskId: 't4',
      displayId: 'NB-4',
      title: 'Dark icon',
      repo: 'app',
      app: 'Android',
      device: 'Pixel 8',
      platform: 'android',
      place: 2,
      waitingFor: { kind: 'build', displayId: 'NB-2', app: 'Android' },
    },
  ],
}

test('the sidebar’s device line opens the panel with live simulator updates', async () => {
  const a = appState()
  a.mount()
  await screen.findByRole('button', { name: '0 of 3 slots in use' })
  a.handle('simulators', () => slots)
  await act(async () => a.emit({ type: 'simulators-changed', simulators: slots }))

  await user().click(
    await screen.findByRole('button', {
      name: 'Simulators and emulators 2 of 2 running · 2 waiting',
    }),
  )
  const d = within(screen.getByRole('dialog', { name: 'Simulators and emulators' }))
  expect(d.getByText(/2 of 2 running on this/)).toBeTruthy()
  expect(within(d.getByRole('region', { name: 'Running' })).getByText('Sync notes')).toBeTruthy()
  expect(
    within(d.getByRole('region', { name: 'Waiting' })).getByText('NB-3 · Share sheet'),
  ).toBeTruthy()

  await user().keyboard('{Escape}')
  expect(screen.queryByRole('dialog', { name: 'Simulators and emulators' })).toBeNull()
})

test('each row opens its Task, shows or stops its device, and the footer opens the limit', async () => {
  const props = {
    onOpenTask: vi.fn(),
    onShow: vi.fn(async () => {}),
    onStop: vi.fn(async () => {}),
    onOpenLimits: vi.fn(),
    onClose: vi.fn(),
  }
  render(<DevicesPopover slots={slots} {...props} />)
  const running = within(screen.getByRole('region', { name: 'Running' }))
  const waiting = within(screen.getByRole('region', { name: 'Waiting' }))

  expect(running.getByText('iPhone · iPhone 16')).toBeTruthy()
  expect(running.getByText('Recording')).toBeTruthy()
  expect(waiting.getByText('1st')).toBeTruthy()
  expect(waiting.getByText('iPhone · iPhone 16 Pro · Waiting for a free device')).toBeTruthy()
  expect(waiting.getByText('Android · Pixel 8 · Waiting for NB-2’s build')).toBeTruthy()
  expect(screen.getByText('At most 2 at once')).toBeTruthy()

  await user().click(running.getByRole('button', { name: 'Show Android' }))
  expect(props.onShow).toHaveBeenCalledWith(
    expect.objectContaining({ taskId: 't2', repo: 'app', app: 'Android' }),
  )

  await user().click(running.getByRole('button', { name: 'Stop iPhone' }))
  expect(props.onStop).toHaveBeenCalledWith(
    expect.objectContaining({ taskId: 't1', repo: 'app', app: 'iPhone' }),
  )

  await user().click(waiting.getByRole('button', { name: 'Stop Android' }))
  expect(props.onStop).toHaveBeenLastCalledWith(
    expect.objectContaining({ taskId: 't4', repo: 'app', app: 'Android' }),
  )

  await user().click(running.getByText('Offline drafts'))
  expect(props.onOpenTask).toHaveBeenCalledWith('t2')
  expect(props.onClose).toHaveBeenCalledTimes(1)

  await user().click(screen.getByRole('button', { name: 'Change in Settings →' }))
  expect(props.onOpenLimits).toHaveBeenCalledTimes(1)
})
