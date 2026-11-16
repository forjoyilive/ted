// @vitest-environment jsdom
import type { Task } from '@ted/protocol'
import { render, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import {
  ArchiveDialog,
  DeleteDialog,
  UnarchiveDialog,
} from '../src/renderer/components/ArchiveDialogs.tsx'
import { ProgressRing } from '../src/renderer/components/ProgressRing.tsx'
import { newChildTaskEvent } from '../src/renderer/hierarchy.ts'
import { TaskDetails } from '../src/renderer/views/TaskThread.tsx'
import { bridge, user } from './support/component.ts'
import { createdAt, factory, task } from './support/fixtures.ts'

const merged = { at: createdAt, pullRequests: [7] }

function family(parentFields: Partial<Task> = {}) {
  const parent = task({
    id: 'p',
    displayId: 'NB-40',
    title: 'Offline editing',
    stage: 'work',
    childIds: ['c1', 'c2', 'c3', 'c4'],
    ...parentFields,
  })
  const done = task({
    id: 'c1',
    displayId: 'NB-41',
    title: 'Local cache',
    parentId: 'p',
    stage: 'done',
    merged,
  })
  const middle = task({
    id: 'c2',
    displayId: 'NB-42',
    title: 'Sync queue',
    parentId: 'p',
    stage: 'work',
    childIds: ['g1', 'g2'],
  })
  const grandchild = task({
    id: 'g1',
    displayId: 'NB-46',
    title: 'Retry limits',
    parentId: 'c2',
    stage: 'validate',
  })
  const clarify = task({
    id: 'c3',
    displayId: 'NB-44',
    title: 'Conflict screen',
    parentId: 'p',
    stage: 'clarify',
  })
  const spike = task({
    id: 'c4',
    displayId: 'NB-45',
    title: 'CRDT spike',
    parentId: 'p',
    stage: 'work',
    archived: { at: createdAt, ended: { kind: 'never-started' } },
    childIds: ['g3'],
  })
  const shelved = task({
    id: 'g2',
    displayId: 'NB-48',
    title: 'Shelved backoff idea',
    parentId: 'c2',
    stage: 'work',
    archived: { at: createdAt, ended: { kind: 'never-started' } },
  })
  const spikeNotes = task({
    id: 'g3',
    displayId: 'NB-47',
    title: 'Spike notes',
    parentId: 'c4',
    stage: 'work',
  })
  const loose = task({ id: 'x', displayId: 'NB-50', title: 'Settings page' })
  return { parent, done, middle, grandchild, clarify, spike, shelved, spikeNotes, loose }
}

function details(subject: Task, tasks: readonly Task[], onOpenTask = vi.fn()) {
  render(
    <TaskDetails
      task={subject}
      tasks={tasks}
      factories={[factory()]}
      onOpenRun={vi.fn()}
      onOpenShell={vi.fn()}
      onOpenTask={onOpenTask}
    />,
  )
  return onOpenTask
}

const detailsHandlers = {
  listApps: () => [],
  simulators: () => ({ supported: false }),
  emulators: () => ({ supported: false }),
  listTaskRuns: () => [],
  taskDescriptions: () => [],
  listComments: () => [],
  taskBrief: () => null,
}

test('a parent shows nested children, merged progress, who it waits for and archived children apart; rows open their Task', async () => {
  bridge(detailsHandlers)
  const f = family()
  const all = Object.values(f)
  const open = details(f.parent, all)
  const labels = screen.getAllByRole('term').map((t) => t.textContent)
  expect(labels.slice(labels.indexOf('Parent'))).toEqual(['Parent', 'Children', 'Blocked by'])
  const children = within(screen.getByRole('region', { name: 'Children' }))
  expect(children.getByText('1 of 3 merged')).toBeTruthy()
  const queueRow = document.querySelector<HTMLElement>('[data-task="NB-42"]')
  if (!queueRow) throw new Error('Missing NB-42 row')
  const nested = within(queueRow).getByRole('img', { name: '0 of 1 child merged' })
  expect(nested.textContent).toBe('0/1')
  expect(nested.getAttribute('title')).toBe('0 of 1 child merged')
  const waiting = children.getByRole('status')
  expect(waiting.textContent).toBe(
    'Waiting for 2 children: NB-42 (Work), NB-44 (Clarify). NB-40 does its own remaining work when they merge.',
  )
  expect(children.getByText('Retry limits')).toBeTruthy()
  const shelved = children.getByText('Shelved backoff idea').closest('div')
  expect(shelved?.textContent).toContain('Archived, not merged')
  expect(children.getByText('Spike notes')).toBeTruthy()
  expect(children.getByText(/Archived without merging/)).toBeTruthy()
  expect(children.getAllByText('Archived, not merged')).toHaveLength(2)
  const u = user()
  await u.click(children.getByRole('button', { name: 'Collapse NB-42' }))
  expect(children.queryByText('Retry limits')).toBeNull()
  await u.click(within(waiting).getByRole('button', { name: 'NB-44' }))
  expect(open).toHaveBeenCalledWith('NB-44')
  await u.click(children.getByText('Local cache'))
  expect(open).toHaveBeenCalledWith('NB-41')
  const rows = children.getAllByRole('button').filter((b) => b.hasAttribute('data-nav-item'))
  expect(rows.map((r) => r.getAttribute('data-task'))).toEqual([
    'NB-41',
    'NB-42',
    'NB-44',
    'NB-45',
    'NB-47',
  ])

  const created = vi.fn()
  window.addEventListener(newChildTaskEvent, created)
  await u.click(children.getByRole('button', { name: 'Create child…' }))
  window.removeEventListener(newChildTaskEvent, created)
  const [[event] = []] = created.mock.calls as unknown as [CustomEvent][]
  expect(event?.detail).toEqual({
    parentId: 'p',
    factoryId: 'f1',
  })
})

test('a Task without children shows only the buttons to add them', () => {
  bridge(detailsHandlers)
  const f = family()
  details(f.loose, Object.values(f))
  const children = within(screen.getByRole('region', { name: 'Children' }))
  expect(children.getByRole('button', { name: 'Create child…' })).toBeTruthy()
  expect(children.getByRole('button', { name: 'Add existing Task…' })).toBeTruthy()
  expect(screen.queryByText(/No children/)).toBeNull()
})

test('attaching an existing Task sends the current revision and shows the daemon’s refusal in the picker', async () => {
  const f = family()
  const setTaskParent = vi
    .fn()
    .mockRejectedValueOnce(
      new Error('NB-40 cannot change its children now. Stop the parent first.'),
    )
    .mockResolvedValue(f.loose)
  const api = bridge({
    ...detailsHandlers,
    taskHierarchy: () => ({ parentId: null, childIds: [], revision: 'rev-1' }),
    setTaskParent,
  })
  details(f.parent, Object.values(f))
  const children = within(screen.getByRole('region', { name: 'Children' }))
  const u = user()
  await u.click(children.getByRole('button', { name: 'Add existing Task…' }))
  const options = within(children.getByRole('listbox', { name: 'Tasks' }))
  expect(options.getAllByRole('option').map((o) => o.textContent)).toEqual(['NB-50Settings page'])
  await u.click(options.getByRole('option'))
  expect(await children.findByRole('alert')).toHaveProperty(
    'textContent',
    'NB-40 cannot change its children now. Stop the parent first.',
  )
  await u.click(options.getByRole('option'))
  expect(api.request).toHaveBeenLastCalledWith('setTaskParent', 'x', {
    parentId: 'p',
    revision: 'rev-1',
  })
  await waitFor(() => expect(children.queryByRole('listbox')).toBeNull())
})

test('a child links to its parent, changes it without offering itself or Tasks under it, and detaches', async () => {
  const f = family()
  const api = bridge({
    ...detailsHandlers,
    taskHierarchy: () => ({ parentId: 'p', childIds: ['g1'], revision: 'rev-2' }),
    setTaskParent: () => f.middle,
  })
  const open = details(f.middle, Object.values(f))
  const u = user()
  await u.click(screen.getByRole('button', { name: /NB-40/ }))
  expect(open).toHaveBeenCalledWith('NB-40')
  await u.click(screen.getByRole('button', { name: 'Change…' }))
  const offered = within(screen.getByRole('listbox', { name: 'Tasks' }))
    .getAllByRole('option')
    .map((o) => o.textContent)
  expect(offered).toEqual(['NB-44Conflict screen', 'NB-47Spike notes', 'NB-50Settings page'])
  await u.keyboard('{Escape}')
  await u.click(screen.getByRole('button', { name: 'Detach' }))
  expect(api.request).toHaveBeenCalledWith('setTaskParent', 'c2', {
    parentId: null,
    revision: 'rev-2',
  })
})

test('archive, delete and unarchive offer the same two choices and send the confirmed revision', async () => {
  const f = family()
  const all = Object.values(f)
  const api = bridge({
    listTasks: () => all,
    listTaskRuns: () => [],
    taskHierarchyPreview: (id: unknown) => ({
      revision: `preview-${String(id)}`,
      descendants: ['c1', 'c2', 'g1', 'c3', 'c4'].map((d) => {
        const t = all.find((x) => x.id === d) as Task
        return { id: t.id, displayId: t.displayId, title: t.title }
      }),
      archivedWith: id === 'p' ? ['c2', 'g1'] : [],
    }),
    archiveTask: vi.fn(),
    deleteTask: vi.fn(),
    unarchiveTask: vi.fn(),
  })
  const u = user()

  const archived = render(<ArchiveDialog task={f.parent} onClose={vi.fn()} />)
  await screen.findByText('4 Tasks are under NB-40')
  expect(screen.getByText('NB-45 is already archived and won’t change.')).toBeTruthy()
  expect(
    (screen.getByRole('radio', { name: /^Archive them with NB-40/ }) as HTMLInputElement).checked,
  ).toBe(true)
  await u.click(screen.getByRole('radio', { name: /^Detach them and keep them/ }))
  await u.click(screen.getByRole('button', { name: 'Archive NB-40' }))
  expect(api.request).toHaveBeenCalledWith('archiveTask', 'p', {
    closePullRequests: false,
    children: 'detach',
    hierarchyRevision: 'preview-p',
  })
  archived.unmount()

  const deleted = render(
    <DeleteDialog task={f.parent} onClose={vi.fn()} onArchiveInstead={vi.fn()} />,
  )
  await screen.findByText('5 Tasks are under NB-40')
  const remove = () =>
    screen.getByRole('button', { name: /^Delete (NB-40|6 Tasks)$/ }) as HTMLButtonElement
  expect(remove().disabled).toBe(true)
  await u.click(screen.getByRole('radio', { name: /^Delete them with NB-40/ }))
  await u.click(screen.getByRole('button', { name: 'Delete 6 Tasks' }))
  expect(api.request).toHaveBeenCalledWith('deleteTask', 'p', {
    children: 'delete',
    hierarchyRevision: 'preview-p',
  })
  deleted.unmount()

  const parentArchived: Task = {
    ...f.parent,
    archived: { at: createdAt, ended: { kind: 'never-started' } },
  }
  const restoring = render(<UnarchiveDialog task={parentArchived} onClose={vi.fn()} />)
  await screen.findByText('Archived with NB-40')
  await u.click(screen.getByRole('button', { name: 'Unarchive 3 Tasks' }))
  expect(api.request).toHaveBeenCalledWith('unarchiveTask', 'p', { children: 'restore' })
  restoring.unmount()
})

test('unarchiving a child greys out both choices while its parent works, and detaches it from an archived parent', async () => {
  const working = family({
    leadRunId: 'run-1',
    runs: [{ id: 'run-1', role: 'lead', state: 'working' }] as Task['runs'],
  })
  const api = bridge({
    listTasks: () => [working.parent, working.spike],
    taskHierarchyPreview: () => ({ revision: 'preview-c4', descendants: [], archivedWith: [] }),
    unarchiveTask: vi.fn(),
  })
  const first = render(<UnarchiveDialog task={working.spike} onClose={vi.fn()} />)
  const together = (await screen.findByRole('radio', {
    name: /^Unarchive it as part of NB-40/,
  })) as HTMLInputElement
  const detach = screen.getByRole('radio', { name: /^Detach it and keep it/ }) as HTMLInputElement
  expect(together.disabled).toBe(true)
  expect(detach.disabled).toBe(true)
  expect(
    screen.getAllByText(/NB-40 is working, and Ted doesn’t change a working Task’s children/),
  ).toHaveLength(2)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(
    (screen.getByRole('button', { name: 'Unarchive NB-45' }) as HTMLButtonElement).disabled,
  ).toBe(true)
  first.unmount()

  const shelved = family({ archived: { at: createdAt, ended: { kind: 'never-started' } } })
  api.handle('listTasks', () => [shelved.parent, shelved.spike])
  render(<UnarchiveDialog task={shelved.spike} onClose={vi.fn()} />)
  await screen.findByText(/NB-40 is archived. Unarchive NB-40 first/)
  expect(
    (screen.getByRole('radio', { name: /^Detach it and keep it/ }) as HTMLInputElement).checked,
  ).toBe(true)
  const button = screen.getByRole('button', { name: 'Unarchive NB-45' }) as HTMLButtonElement
  await waitFor(() => expect(button.disabled).toBe(false))
  await user().click(button)
  expect(api.request).toHaveBeenCalledWith('unarchiveTask', 'c4', {
    unlinkParent: true,
    hierarchyRevision: 'preview-c4',
  })
})

test('the progress ring counts merged children and marks a finished parent', () => {
  render(
    <>
      <ProgressRing merged={1} total={3} />
      <ProgressRing merged={3} total={3} />
    </>,
  )
  const partial = screen.getByRole('img', { name: '1 of 3 children merged' })
  expect(partial.textContent).toBe('1/3')
  expect(partial.hasAttribute('data-done')).toBe(false)
  const done = screen.getByRole('img', { name: '3 of 3 children merged' })
  expect(done.textContent).toBe('3/3')
  expect(done.hasAttribute('data-done')).toBe(true)
})
