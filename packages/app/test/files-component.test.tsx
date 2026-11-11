// @vitest-environment jsdom
import type { PullRequestChanges, TaskChanges, TaskFiles, TaskRepo } from '@ted/protocol'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { usePullRequestChanges } from '../src/renderer/changes.ts'
import { CommentFiles } from '../src/renderer/components/CommentFiles.tsx'
import { DesignReviewContent } from '../src/renderer/components/DesignReview.tsx'
import { FilesSection } from '../src/renderer/components/FilesSection.tsx'
import { FileView } from '../src/renderer/components/FileView.tsx'
import { QuickOpen } from '../src/renderer/components/QuickOpen.tsx'
import { Viewer } from '../src/renderer/components/Viewer.tsx'
import { ConnectionContext } from '../src/renderer/data.ts'
import { useTaskFiles } from '../src/renderer/files.ts'
import { appState } from './support/app.tsx'
import { bridge, deferred, user } from './support/component.ts'
import { comment, task } from './support/fixtures.ts'

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

test('the text viewer escapes HTML and opens a labeled snapshot through the existing editor action', async () => {
  const a = bridge({
    taskFile: () => ({ kind: 'text', text: '<img src=x onerror=alert(1)>\nhello' }),
    getSettings: () => ({ editor: 'code' }),
    openInEditor: () => ({}),
  })
  render(<FileView taskId="NB-1" file={{ repo: 'web', path: 'page.html' }} onBack={vi.fn()} />)
  await screen.findByText('<img src=x onerror=alert(1)>')
  expect(screen.getByRole('region', { name: 'File contents' }).querySelector('img')).toBeNull()
  await user().click(screen.getByRole('button', { name: 'Open snapshot' }))
  expect(screen.getByText(/Edits to the snapshot do not change Task files/)).toBeTruthy()
  expect(a.request).toHaveBeenCalledWith('openInEditor', 'NB-1', 'web', {
    file: 'page.html',
    snapshot: true,
  })
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
    else await user().click(await screen.findByRole('button', { name: 'All changes' }))
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

test.each(['binary', 'too-large', 'unavailable'] as const)(
  'the viewer disables snapshots for %s content',
  async (kind) => {
    const a = bridge({ taskFile: () => ({ kind, message: 'Preview unavailable.' }) })
    render(<FileView taskId="NB-1" file={{ repo: 'web', path: 'file' }} onBack={vi.fn()} />)
    await screen.findByText('Preview unavailable.')
    const button = screen.getByRole('button', { name: 'Open snapshot' })
    expect(button.hasAttribute('disabled')).toBe(true)
    await user().click(button)
    expect(a.request.mock.calls.some(([name]) => name === 'openInEditor')).toBe(false)
  },
)

test('a Comment’s image buttons browse in display order, wrap, and restore the opened thumbnail', async () => {
  bridge({ readAttachment: () => ({ data: 'aW1hZ2U=' }) })
  const image = (name: string) => ({ hash: name, name, mediaType: 'image/png', size: 5 })
  render(
    <>
      <CommentFiles
        files={[
          image('first.png'),
          { ...image('notes.pdf'), mediaType: 'application/pdf' },
          image('middle.png'),
          image('last.png'),
        ]}
      />
      <CommentFiles files={[image('other-comment.png')]} />
    </>,
  )
  const thumbnail = await screen.findByRole('button', { name: 'View middle.png' })
  await user().click(thumbnail)
  const dialog = screen.getByRole('dialog', { name: 'middle.png' })
  expect(within(dialog).getByRole('status').textContent).toBe('2 of 3')
  await user().click(within(dialog).getByRole('button', { name: 'Next image' }))
  await within(dialog).findByRole('img', { name: 'last.png' })
  await user().click(within(dialog).getByRole('button', { name: 'Next image' }))
  await within(dialog).findByRole('img', { name: 'first.png' })
  expect(within(dialog).getByRole('status').textContent).toBe('1 of 3')
  await user().click(within(dialog).getByRole('button', { name: 'Previous image' }))
  await within(dialog).findByRole('img', { name: 'last.png' })
  await user().click(within(dialog).getByRole('button', { name: /^Close$/ }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(thumbnail)
  await user().click(screen.getByRole('button', { name: 'View other-comment.png' }))
  const single = screen.getByRole('dialog', { name: 'other-comment.png' })
  expect(within(single).queryByRole('button', { name: 'Next image' })).toBeNull()
  expect(within(single).queryByRole('status')).toBeNull()
  fireEvent(single, new Event('cancel', { cancelable: true }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('Left and Right browse the open image group through the app keymap without modified-key or dialog interference', async () => {
  const a = appState()
  const image = (name: string) => ({ hash: name, name, mediaType: 'image/png', size: 5 })
  a.state.tasks = [task()]
  a.handle('listComments', () => [
    comment({
      kind: 'note',
      author: { kind: 'human' },
      attachments: [image('first.png'), image('second.png')],
    }),
  ])
  a.handle('readAttachment', () => ({ data: 'aW1hZ2U=' }))
  a.mount()
  const nav = await screen.findByRole('navigation', { name: 'Sidebar' })
  await user().click(within(nav).getByRole('button', { name: 'All Tasks' }))
  await user().click(await screen.findByRole('row', { name: /NB-1/ }))
  const thumbnail = await screen.findByRole('button', { name: 'View first.png' })
  await user().click(thumbnail)
  const dialog = screen.getByRole('dialog', { name: 'first.png' })
  await user().keyboard('{ArrowLeft}')
  await within(dialog).findByRole('img', { name: 'second.png' })
  expect(within(dialog).getByRole('status').textContent).toBe('2 of 2')
  await user().keyboard('{ArrowRight}')
  await within(dialog).findByRole('img', { name: 'first.png' })
  await user().keyboard(
    '{Control>}{ArrowRight}{/Control}{Alt>}{ArrowLeft}{/Alt}{Shift>}{ArrowRight}{/Shift}{Meta>}{ArrowLeft}{/Meta}',
  )
  expect(within(dialog).getByRole('heading', { name: 'first.png' })).toBeTruthy()
  const blocker = render(
    <Viewer title="Another dialog" onClose={vi.fn()}>
      <input aria-label="Editable text" />
      <button type="button">Other action</button>
    </Viewer>,
  )
  await user().click(screen.getByRole('button', { name: 'Other action' }))
  await user().keyboard('{ArrowRight}')
  expect(within(dialog).getByRole('heading', { name: 'first.png' })).toBeTruthy()
  await user().click(screen.getByRole('textbox', { name: 'Editable text' }))
  await user().keyboard('{ArrowRight}')
  expect(within(dialog).getByRole('heading', { name: 'first.png' })).toBeTruthy()
  blocker.unmount()
  fireEvent(dialog, new Event('cancel', { cancelable: true }))
  expect(document.activeElement).toBe(thumbnail)
  await user().click(screen.getByRole('button', { name: 'View second.png' }))
  await within(screen.getByRole('dialog')).findByRole('img', { name: 'second.png' })
})

test('browsing a loading or failed image never shows the previous image and can continue', async () => {
  const pending = deferred<{ data: string }>()
  let viewing = false
  bridge({
    readAttachment: (attachment) => {
      const name = (attachment as { name: string }).name
      if (viewing && name === 'slow.png') return pending.promise
      if (viewing && name === 'broken.png') throw new Error('Image bytes unavailable')
      return { data: 'aW1hZ2U=' }
    },
  })
  const images = ['first.png', 'slow.png', 'broken.png'].map((name) => ({
    hash: name,
    name,
    mediaType: 'image/png',
    size: 5,
  }))
  render(<CommentFiles files={images} />)
  await screen.findByRole('button', { name: 'View slow.png' })
  await screen.findByRole('button', { name: 'View broken.png' })
  viewing = true
  await user().click(screen.getByRole('button', { name: 'View first.png' }))
  const dialog = screen.getByRole('dialog')
  await within(dialog).findByRole('img', { name: 'first.png' })
  await user().click(within(dialog).getByRole('button', { name: 'Next image' }))
  expect(within(dialog).queryByRole('img')).toBeNull()
  expect(within(dialog).getByRole('status', { name: 'Loading slow.png…' })).toBeTruthy()
  await user().click(within(dialog).getByRole('button', { name: 'Next image' }))
  expect((await within(dialog).findByRole('alert')).textContent).toBe('Image bytes unavailable')
  expect(within(dialog).queryByRole('img')).toBeNull()
  await user().click(within(dialog).getByRole('button', { name: 'Next image' }))
  await within(dialog).findByRole('img', { name: 'first.png' })
  await act(async () => pending.resolve({ data: 'c3RhbGU=' }))
  expect(within(dialog).getByRole('img', { name: 'first.png' }).getAttribute('src')).toBe(
    'data:image/png;base64,aW1hZ2U=',
  )
  expect(within(dialog).queryByRole('alert')).toBeNull()
})

test('design review screenshots browse their displayed group using captions and the attachment media type', async () => {
  bridge({ readAttachment: () => ({ data: 'aW1hZ2U=' }) })
  render(
    <DesignReviewContent
      taskId="NB-1"
      commentId="review"
      files={[{ hash: 'b', name: 'second.gif', mediaType: 'image/gif', size: 5 }]}
      design={{
        screenshots: [
          { hash: 'a', name: 'first.png', caption: 'Before' },
          { hash: 'b', name: 'second.gif', caption: 'After' },
        ],
      }}
    />,
  )
  await screen.findByRole('img', { name: 'After' })
  const thumbnail = screen.getByRole('button', { name: 'View After' })
  await user().click(thumbnail)
  const dialog = screen.getByRole('dialog', { name: 'After' })
  expect((await within(dialog).findByRole('img', { name: 'After' })).getAttribute('src')).toBe(
    'data:image/gif;base64,aW1hZ2U=',
  )
  await user().click(within(dialog).getByRole('button', { name: 'Next image' }))
  await within(dialog).findByRole('img', { name: 'Before' })
  expect(within(dialog).getByRole('status').textContent).toBe('1 of 2')
  await user().click(within(dialog).getByRole('button', { name: /^Close$/ }))
  expect(document.activeElement).toBe(thumbnail)
})

const localChanges: TaskChanges = {
  taskId: 'NB-1',
  files: 1,
  repos: [
    {
      name: 'web',
      baseBranch: 'main',
      added: 1,
      removed: 0,
      files: [{ path: 'local-only.ts', added: 1, removed: 0, uncommitted: true }],
    },
  ],
}
const prChanges: PullRequestChanges = {
  repo: {
    name: 'web',
    baseBranch: 'main',
    added: 1,
    removed: 0,
    files: [{ path: 'pushed.ts', added: 1, removed: 0, uncommitted: false }],
  },
  number: 7,
  state: 'Open',
  head: 'a'.repeat(40),
  base: 'b'.repeat(40),
  loadedAt: '2026-11-11T12:00:00Z',
  diffs: [
    {
      repo: 'web',
      path: 'pushed.ts',
      added: 1,
      removed: 0,
      head: 'a'.repeat(40),
      mergeBase: 'c'.repeat(40),
      uncommitted: false,
      hunks: [
        {
          header: '@@ -0,0 +1 @@',
          rows: [{ kind: 'added', new: 1, text: '<img src=x onerror=alert(1)>' }],
        },
      ],
    },
  ],
}
const withPr: TaskRepo = {
  ...repo,
  pullRequest: {
    number: 7,
    url: 'https://github.com/acme/web/pull/7',
    base: 'main',
    state: 'ready',
  },
}

async function openChangesTask(a: ReturnType<typeof appState>) {
  a.handle('taskChanges', () => localChanges)
  a.handle('fileDiffs', () => [])
  a.mount()
  const nav = await screen.findByRole('navigation', { name: 'Sidebar' })
  await user().click(within(nav).getByRole('button', { name: 'All Tasks' }))
  await user().click(await screen.findByRole('row', { name: /NB-1/ }))
  await screen.findByRole('region', { name: 'Task thread' })
  return screen.findByRole('region', { name: 'Changes' })
}

test('an open PR retains local access; both sources use the reader without mixing code or offering local actions on PR lines', async () => {
  const a = appState()
  a.state.tasks = [task({ repos: [repo], stage: 'work' })]
  const pending = deferred<PullRequestChanges>()
  a.handle('pullRequestChanges', () => pending.promise)
  const changes = await openChangesTask(a)
  await within(changes).findByRole('button', { name: /local-only.ts/ })
  expect(within(changes).queryByRole('button', { name: 'Pull request changes' })).toBeNull()
  await a.emitTask(task({ repos: [withPr], stage: 'work' }))
  await user().click(await within(changes).findByRole('button', { name: 'Pull request changes' }))
  await screen.findByRole('region', { name: 'All changes' })
  expect(screen.getByRole('complementary', { name: 'Task details' })).toBeTruthy()
  expect(within(changes).queryByRole('button', { name: /local-only.ts/ })).toBeNull()
  await user().click(within(changes).getByRole('button', { name: 'Local changes' }))
  await act(async () => pending.resolve(prChanges))
  await within(changes).findByRole('button', { name: /local-only.ts/ })
  expect(within(changes).queryByRole('button', { name: /pushed.ts/ })).toBeNull()
  await user().click(within(changes).getByRole('button', { name: 'Pull request changes' }))
  const all = screen.getByRole('region', { name: 'All changes' })
  await within(all).findByText('<img src=x onerror=alert(1)>')
  expect(all.querySelector('img')).toBeNull()
  expect(within(all).queryByRole('button', { name: /Comment on line|Open in editor/ })).toBeNull()
  await user().click(await within(changes).findByRole('button', { name: /pushed.ts/ }))
  const diff = screen.getByRole('region', { name: 'Diff' })
  await within(diff).findByText('<img src=x onerror=alert(1)>')
  expect(within(diff).getByText(/pushed revision aaaaaaa/)).toBeTruthy()
  expect(within(diff).queryByRole('button', { name: /Comment on line|Open in editor/ })).toBeNull()
  expect(a.request.mock.calls.filter(([name]) => name === 'fileDiffs')).toHaveLength(1)
})

test('PR refresh failure clears old code, remains separate from local work, and recovers even without a worktree', async () => {
  const a = appState()
  a.state.tasks = [
    task({ repos: [{ ...withPr, removed: { at: '2026-11-11T12:00:00Z' } }], stage: 'review' }),
  ]
  a.handle('pullRequestChanges', () => prChanges)
  const changes = await openChangesTask(a)
  await user().click(within(changes).getByRole('button', { name: 'Pull request changes' }))
  const all = screen.getByRole('region', { name: 'All changes' })
  await within(all).findByText('<img src=x onerror=alert(1)>')
  a.handle('pullRequestChanges', () => {
    throw new Error('secret failure detail')
  })
  await user().click(within(all).getByRole('button', { name: 'Refresh' }))
  await within(all).findByText(/Couldn’t load pull request #7/)
  expect(within(all).queryByText('<img src=x onerror=alert(1)>')).toBeNull()
  expect(within(all).queryByText(/secret failure detail/)).toBeNull()
  expect(within(changes).queryByRole('button', { name: /local-only.ts/ })).toBeNull()
  a.handle('pullRequestChanges', () => prChanges)
  await user().click(within(all).getByRole('button', { name: 'Retry' }))
  await within(all).findByText('<img src=x onerror=alert(1)>')
})

test('a failed PR in a second repo does not hide the first repo’s pushed files', async () => {
  const a = appState()
  const api: TaskRepo = {
    ...withPr,
    name: 'api',
    repo: 'acme/api',
    pullRequest: {
      ...withPr.pullRequest,
      number: 8,
      url: 'https://github.com/acme/api/pull/8',
      base: 'main',
      state: 'ready',
    },
  }
  a.state.tasks = [task({ repos: [withPr, api], stage: 'review' })]
  a.handle('pullRequestChanges', (_id, name) => {
    if (name === 'api') throw new Error('Offline')
    return { ...prChanges, limited: true }
  })
  const changes = await openChangesTask(a)
  await user().click(within(changes).getByRole('button', { name: 'Pull request changes' }))
  const all = screen.getByRole('region', { name: 'All changes' })
  await within(all).findByText('<img src=x onerror=alert(1)>')
  expect(within(all).getByText(/api: Couldn’t load pull request #8/)).toBeTruthy()
  expect(within(all).getByText(/first 1,000 files only/)).toBeTruthy()
  expect(within(changes).getByRole('button', { name: /pushed.ts/ })).toBeTruthy()
})

function PrListing({ id }: { id: string }) {
  const result = usePullRequestChanges(task({ id, repos: [withPr] }), true)
  return (
    <p>
      {result.changes?.repos
        .flatMap((r) => r.files)
        .map((f) => f.path)
        .join(',') ?? 'Loading PR changes'}
    </p>
  )
}

test('PR snapshots clear on reconnect and ignore an earlier Task’s reply', async () => {
  const old = deferred<PullRequestChanges>()
  const reconnect = deferred<PullRequestChanges>()
  let calls = 0
  const a = bridge({
    pullRequestChanges: (id) =>
      id === 'old' ? old.promise : ++calls === 1 ? prChanges : reconnect.promise,
  })
  const wrap = (id: string, epoch: number) => (
    <ConnectionContext value={{ connection: { state: 'connected' }, epoch }}>
      <PrListing id={id} />
    </ConnectionContext>
  )
  const view = render(wrap('old', 0))
  view.rerender(wrap('new', 0))
  await screen.findByText('pushed.ts')
  view.rerender(wrap('new', 1))
  expect(screen.queryByText('pushed.ts')).toBeNull()
  await act(async () =>
    old.resolve({
      ...prChanges,
      repo: {
        ...prChanges.repo,
        files: [{ path: 'stale.ts', added: 0, removed: 0, uncommitted: false }],
      },
    }),
  )
  expect(screen.queryByText('stale.ts')).toBeNull()
  expect(screen.getByText('Loading PR changes')).toBeTruthy()
  await act(async () => reconnect.resolve(prChanges))
  await screen.findByText('pushed.ts')
  expect(a.request.mock.calls.filter(([name]) => name === 'pullRequestChanges')).toHaveLength(3)
})
