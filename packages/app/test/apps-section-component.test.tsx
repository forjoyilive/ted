// @vitest-environment jsdom
import type { TaskApp } from '@ted/protocol'
import { act, render, screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { AppsSection } from '../src/renderer/components/AppsSection.tsx'
import { bridge, deferred, user } from './support/component.ts'
import { task } from './support/fixtures.ts'

const web: TaskApp = { repo: 'widgets', name: 'Web', kind: 'web', state: 'stopped' }

const devices = { simulators: () => undefined, emulators: () => undefined }

function show(taskId: string) {
  render(
    <AppsSection
      task={task({ id: taskId, displayId: taskId })}
      shown={undefined}
      onOpenApp={() => {}}
    />,
  )
  return screen.getByRole('tabpanel', { name: 'Apps' })
}

test('the Apps tab shows a spinner, not the empty message, until the list arrives', async () => {
  const empty = deferred<TaskApp[]>()
  bridge({ ...devices, listApps: () => empty.promise })
  const panel = show('NB-21')
  expect(within(panel).getByRole('status', { name: 'Loading Apps…' })).toBeTruthy()
  expect(within(panel).queryByText('No Apps for this Task')).toBeNull()
  await act(async () => empty.resolve([]))
  expect(await within(panel).findByText('No Apps for this Task')).toBeTruthy()
  expect(within(panel).queryByRole('status')).toBeNull()
})

test('a Task with Apps goes from the spinner straight to its Apps', async () => {
  const apps = deferred<TaskApp[]>()
  bridge({ ...devices, listApps: () => apps.promise })
  const panel = show('NB-22')
  expect(within(panel).getByRole('status', { name: 'Loading Apps…' })).toBeTruthy()
  await act(async () => apps.resolve([web]))
  expect(await within(panel).findByText('Web')).toBeTruthy()
  expect(within(panel).queryByText('No Apps for this Task')).toBeNull()
})

test('a failed load says so and Try again loads the Apps', async () => {
  let fail = true
  bridge({
    ...devices,
    listApps: () => {
      if (fail) throw new Error('Ted didn’t answer')
      return [web]
    },
  })
  const panel = show('NB-23')
  const alert = await within(panel).findByRole('alert')
  expect(alert.textContent).toContain('Couldn’t load Apps: Ted didn’t answer')
  expect(within(panel).queryByText('No Apps for this Task')).toBeNull()
  fail = false
  await user().click(within(alert).getByRole('button', { name: 'Try again' }))
  expect(await within(panel).findByText('Web')).toBeTruthy()
  expect(within(panel).queryByRole('alert')).toBeNull()
})
