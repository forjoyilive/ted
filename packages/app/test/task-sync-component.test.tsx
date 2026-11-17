// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { expect, test } from 'vitest'
import { TaskSyncField } from '../src/renderer/components/AsanaImportPreview.tsx'
import './support/component.ts'

test('a merged Asana parent shows whether it waits on Tasks, needs an answer or was left open', () => {
  const drawn = render(
    <>
      <TaskSyncField sync={{ state: 'waiting-children', openChildren: 2, linked: 1 }} />
      <TaskSyncField sync={{ state: 'needs-answer', linked: 1 }} />
      <TaskSyncField sync={{ state: 'left-open', linked: 1 }} />
    </>,
  )
  const text = (state: string) =>
    drawn.container.querySelector(`[data-task-sync="${state}"]`)?.textContent
  expect(text('waiting-children')).toContain('Their Ted Tasks complete them on merging')
  expect(text('needs-answer')).toContain('Waiting for your answer')
  expect(text('needs-answer')).toContain('Answer the question in this Task’s thread.')
  expect(text('left-open')).toContain('Left open in Asana')
})
