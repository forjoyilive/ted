// @vitest-environment jsdom
import type { TaskFiles, TaskRepo } from '@ted/protocol'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { FilesSection } from '../src/renderer/components/FilesSection.tsx'
import { FileView } from '../src/renderer/components/FileView.tsx'
import { QuickOpen } from '../src/renderer/components/QuickOpen.tsx'
import { ConnectionContext } from '../src/renderer/data.ts'
import { useTaskFiles } from '../src/renderer/files.ts'
import { appState } from './support/app.tsx'
import { bridge, deferred, user } from './support/component.ts'
import { task } from './support/fixtures.ts'

const repo: TaskRepo = {
  name: 'web',
  repo: 'acme/web',
  worktree: '/w/web',
  branch: 'task-branch',
  copied: [],
  skipped: [],
}
const files: TaskFiles = {
  taskId: 'NB-1',
  repos: [
    { repo: 'web', paths: ['src/hello.ts', 'README.md'], partial: false },
    {
      repo: 'api',
      paths: ['README.md'],
      partial: true,
      unavailable: 'Worktree files are unavailable.',
    },
  ],
}

test('the file tree opens a file absent from Changes, retains its path, and shows repo errors', async () => {
  const onOpen = vi.fn()
  const browse = vi.fn()
  render(
    <FilesSection
      task={task({ repos: [repo] })}
      files={files}
      error={undefined}
      selected={undefined}
      onOpen={onOpen}
      onBrowse={browse}
      refresh={vi.fn()}
      onQuickOpen={vi.fn()}
    />,
  )
  const section = screen.getByRole('region', { name: 'Files' })
  fireEvent.click(within(section).getByText('src'))
  await user().click(within(section).getByRole('button', { name: 'hello.ts' }))
  expect(onOpen).toHaveBeenCalledWith({ repo: 'web', path: 'src/hello.ts' })
  expect(browse).toHaveBeenCalledOnce()
  expect(within(section).getByRole('alert').textContent).toContain('api')
  expect(within(section).getByText(/first 20,000/)).toBeTruthy()
})

test('quick open supports path matching, keyboard choice, empty results and close', async () => {
  const onOpen = vi.fn()
  const close = vi.fn()
  render(
    <QuickOpen files={files} error={undefined} onClose={close} onOpen={onOpen} refresh={vi.fn()} />,
  )
  const input = screen.getByRole('combobox')
  expect(document.activeElement).toBe(input)
  fireEvent.change(input, { target: { value: 'readme' } })
  expect(screen.getAllByRole('option')).toHaveLength(2)
  await user().keyboard('{ArrowDown}{Enter}')
  expect(onOpen).toHaveBeenCalledWith({ repo: 'web', path: 'README.md' })
  fireEvent.change(input, { target: { value: 'web src/hello' } })
  await user().keyboard('{Enter}')
  expect(onOpen).toHaveBeenLastCalledWith({ repo: 'web', path: 'src/hello.ts' })
  fireEvent.change(input, { target: { value: 'nothing' } })
  expect(screen.getByText('No files match this name or path.')).toBeTruthy()
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
  expect(close).toHaveBeenCalledOnce()
})

test('the text viewer escapes HTML and routes the file to the existing editor action', async () => {
  const a = bridge({
    taskFile: () => ({ kind: 'text', text: '<img src=x onerror=alert(1)>\nhello' }),
    getSettings: () => ({ editor: 'code' }),
    openInEditor: () => ({}),
  })
  render(<FileView taskId="NB-1" file={{ repo: 'web', path: 'page.html' }} onBack={vi.fn()} />)
  await screen.findByText('<img src=x onerror=alert(1)>')
  expect(screen.getByRole('region', { name: 'File contents' }).querySelector('img')).toBeNull()
  await user().click(screen.getByRole('button', { name: 'Open in editor' }))
  expect(a.request).toHaveBeenCalledWith('openInEditor', 'NB-1', 'web', { file: 'page.html' })
})

test('old responses cannot replace a newly selected file', async () => {
  const old = deferred<{ kind: 'text'; text: string }>()
  bridge({
    taskFile: (_task, _repo, path) =>
      path === 'old.ts'
        ? old.promise
        : { kind: 'binary', message: 'This file can’t be shown as text.' },
  })
  const view = render(
    <FileView key="old" taskId="NB-1" file={{ repo: 'web', path: 'old.ts' }} onBack={vi.fn()} />,
  )
  view.rerender(
    <FileView key="new" taskId="NB-1" file={{ repo: 'web', path: 'new.png' }} onBack={vi.fn()} />,
  )
  await screen.findByText('This file can’t be shown as text.')
  await act(async () => old.resolve({ kind: 'text', text: 'stale text' }))
  expect(screen.queryByText('stale text')).toBeNull()
})

function Listing({ id }: { id: string }) {
  const { files, error } = useTaskFiles(task({ id, repos: [repo] }), true)
  return <p>{error ?? files?.repos[0]?.paths.join(',') ?? 'Loading files'}</p>
}

test('lists reload on reconnect and ignore responses for an earlier Task', async () => {
  const old = deferred<TaskFiles>()
  const a = bridge({
    taskFiles: (id) =>
      id === 'old'
        ? old.promise
        : { taskId: id, repos: [{ repo: 'web', paths: ['new.ts'], partial: false }] },
  })
  const wrap = (id: string, epoch: number) => (
    <ConnectionContext value={{ connection: { state: 'connected' }, epoch }}>
      <Listing id={id} />
    </ConnectionContext>
  )
  const view = render(wrap('old', 0))
  view.rerender(wrap('new', 0))
  await screen.findByText('new.ts')
  await act(async () =>
    old.resolve({ taskId: 'old', repos: [{ repo: 'web', paths: ['old.ts'], partial: false }] }),
  )
  expect(screen.queryByText('old.ts')).toBeNull()
  view.rerender(wrap('new', 1))
  await act(async () => {})
  expect(a.request.mock.calls.filter(([name]) => name === 'taskFiles')).toHaveLength(3)
})

test('Cmd/Ctrl+P opens the Task file dialog through the shared keymap and choosing a result opens the viewer', async () => {
  const a = appState()
  a.state.tasks = [task({ repos: [repo], stage: 'work' })]
  a.handle('taskFiles', () => files)
  a.handle('taskFile', () => ({ kind: 'text', text: 'unchanged file contents' }))
  a.mount()
  const nav = await screen.findByRole('navigation', { name: 'Sidebar' })
  await user().click(within(nav).getByRole('button', { name: 'All Tasks' }))
  await user().click(await screen.findByRole('row', { name: /NB-1/ }))
  await screen.findByRole('region', { name: 'Task thread' })
  await user().keyboard('{Control>}p{/Control}')
  const quick = await screen.findByRole('dialog', { name: 'Quick open' })
  fireEvent.change(within(quick).getByRole('combobox'), { target: { value: 'hello' } })
  await user().keyboard('{Enter}')
  await screen.findByText('unchanged file contents')
  expect(screen.queryByRole('dialog', { name: 'Quick open' })).toBeNull()
  await user().click(screen.getByRole('button', { name: '← Thread' }))
  expect(screen.queryByRole('region', { name: 'File contents' })).toBeNull()
})

test.each(['Full brief', 'All changes'])(
  'file inspection restores %s without drawing both views',
  async (previous) => {
    const a = appState()
    a.state.tasks = [task({ repos: [repo], stage: 'work' })]
    a.handle('taskFiles', () => files)
    a.handle('taskFile', () => ({ kind: 'text', text: 'inspected contents' }))
    a.handle('taskBrief', () => ({
      taskId: 'NB-1',
      version: 1,
      stage: 'work',
      text: '## Goal\n\nInspect files.\n',
      createdAt: '2026-11-09T12:00:00.000Z',
    }))
    a.handle('taskChanges', () => ({
      taskId: 'NB-1',
      files: 1,
      repos: [
        {
          name: 'web',
          baseBranch: 'main',
          added: 1,
          removed: 0,
          files: [{ path: 'README.md', added: 1, removed: 0, uncommitted: true }],
        },
      ],
    }))
    a.handle('fileDiffs', () => [])
    a.mount()
    const nav = await screen.findByRole('navigation', { name: 'Sidebar' })
    await user().click(within(nav).getByRole('button', { name: 'All Tasks' }))
    await user().click(await screen.findByRole('row', { name: /NB-1/ }))
    if (previous === 'Full brief')
      await user().click(await screen.findByRole('button', { name: 'Full brief' }))
    else await user().click(await screen.findByRole('button', { name: 'Expand all' }))
    await screen.findByRole('region', { name: previous })
    await user().keyboard('{Control>}p{/Control}')
    const quick = await screen.findByRole('dialog', { name: 'Quick open' })
    fireEvent.change(within(quick).getByRole('combobox'), { target: { value: 'hello' } })
    await user().keyboard('{Enter}')
    await screen.findByText('inspected contents')
    expect(screen.queryByRole('region', { name: previous })).toBeNull()
    await user().click(screen.getByRole('button', { name: '← Back' }))
    await screen.findByRole('region', { name: previous })
    expect(screen.queryByRole('region', { name: 'File contents' })).toBeNull()
  },
)
