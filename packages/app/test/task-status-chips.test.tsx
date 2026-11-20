// @vitest-environment jsdom
import type { TaskMarker } from '@ted/protocol'
import { render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { TaskStatusChips } from '../src/renderer/components/TaskStatus.tsx'
import { task } from './support/fixtures.ts'

const runningChecks: TaskMarker = {
  kind: 'test-activity',
  source: 'checks',
  phase: 'running',
  label: 'Running checks',
  detail: 'Tests · 1 of 2 checks',
}

test('an App starting shows Starting app instead of Working', () => {
  render(
    <TaskStatusChips
      task={task({ status: { kind: 'working', app: 'Ted iPhone' }, markers: [] })}
      onOpenTask={vi.fn()}
    />,
  )
  expect(screen.getByText('Starting app')).toBeTruthy()
  expect(screen.queryByText('Working')).toBeNull()
})

test('a running checks chip replaces the Working chip, but not Starting app', () => {
  const { unmount } = render(
    <TaskStatusChips
      task={task({ status: { kind: 'working' }, markers: [runningChecks] })}
      onOpenTask={vi.fn()}
    />,
  )
  expect(screen.getByText('Running checks')).toBeTruthy()
  expect(screen.queryByText('Working')).toBeNull()
  unmount()
  render(
    <TaskStatusChips
      task={task({ status: { kind: 'working', app: 'Ted iPhone' }, markers: [runningChecks] })}
      onOpenTask={vi.fn()}
    />,
  )
  expect(screen.getByText('Starting app')).toBeTruthy()
  expect(screen.getByText('Running checks')).toBeTruthy()
})
