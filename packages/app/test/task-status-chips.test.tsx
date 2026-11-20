// @vitest-environment jsdom
import type { TaskMarker } from '@ted/protocol'
import { render, within } from '@testing-library/react'
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

const chips = (fields: Parameters<typeof task>[0]) =>
  within(render(<TaskStatusChips task={task(fields)} onOpenTask={vi.fn()} />).container)

test('an App starting shows Starting app instead of Working', () => {
  const view = chips({ status: { kind: 'working', app: 'Ted iPhone' }, markers: [] })
  expect(view.getByText('Starting app')).toBeTruthy()
  expect(view.queryByText('Working')).toBeNull()
})

test('a running checks chip replaces the Working chip, but not Starting app', () => {
  const working = chips({ status: { kind: 'working' }, markers: [runningChecks] })
  expect(working.getByText('Running checks')).toBeTruthy()
  expect(working.queryByText('Working')).toBeNull()
  const starting = chips({
    status: { kind: 'working', app: 'Ted iPhone' },
    markers: [runningChecks],
  })
  expect(starting.getByText('Starting app')).toBeTruthy()
  expect(starting.getByText('Running checks')).toBeTruthy()
})
