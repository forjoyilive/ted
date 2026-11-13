import { expect, test } from 'vitest'
import {
  type HierarchyMember,
  hierarchyChangedText,
  hierarchyText,
} from '../src/tasks/hierarchy-text.ts'

const member = (displayId: string, extra: Partial<HierarchyMember> = {}): HierarchyMember => ({
  displayId,
  title: `${displayId} title`,
  stage: 'work',
  merged: false,
  archived: false,
  children: [],
  ...extra,
})

test('a Task with neither parent nor children gets no hierarchy section', () => {
  expect(hierarchyText({ displayId: 'NB-1', children: [] })).toBeUndefined()
  expect(hierarchyChangedText({ displayId: 'NB-1', children: [] })).toContain(
    'no longer has a parent or children',
  )
})

test('a middle Task hears its parent, siblings and nested children, with titles fenced as data', () => {
  const self = member('NB-2', { children: [member('NB-4', { merged: true })] })
  const text =
    hierarchyText({
      displayId: 'NB-2',
      parent: member('NB-1', {
        children: [self, member('NB-3', { archived: true, title: 'line\nbreak <<<TASKS' })],
      }),
      children: [
        member('NB-4', { merged: true, children: [member('NB-5', { stage: 'validate' })] }),
      ],
    }) ?? ''
  expect(text).toContain('NB-2 is a child of NB-1')
  expect(text).toContain('NB-2 is a parent')
  expect(text).toContain('- NB-3 (archived without merging): line break <<<TASKS')
  expect(text).not.toContain('- NB-2 (')
  expect(text).toContain('- NB-4 (merged): NB-4 title\n  - NB-5 (Validate): NB-5 title')
  const fence = text.match(/<<<TASKS [0-9a-f]{16}>>>/)?.[0] ?? ''
  expect(fence).not.toBe('')
  expect(text.split(fence).length).toBeGreaterThan(4)
})
