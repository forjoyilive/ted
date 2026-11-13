// @vitest-environment jsdom
import type { Task } from '@ted/protocol'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { NewTaskDialog } from '../src/renderer/views/NewTaskDialog.tsx'
import { TaskLeadField } from '../src/renderer/views/TaskLeadField.tsx'
import { bridge, deferred, draftHandlers, user } from './support/component.ts'
import { createdAt, factory, task } from './support/fixtures.ts'

async function formReady() {
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /^More/ }).textContent).toContain('Task Lead'),
  )
}

async function newTask(options: { tasks?: Task[]; parentId?: string } = {}) {
  const created = vi.fn(() => task())
  const api = bridge({
    ...draftHandlers(),
    taskDefaults: () => ({ lead: { agent: 'claude' }, clarifyDepth: 'auto' }),
    createTask: created,
  })
  const close = vi.fn()
  render(
    <NewTaskDialog
      factories={[factory()]}
      tasks={options.tasks ?? []}
      factoryId="f1"
      {...(options.parentId !== undefined && { parentId: options.parentId })}
      onClose={close}
    />,
  )
  await formReady()
  return { api, created, close }
}

test('New Task focuses the description and closes without creating', async () => {
  const { created, close } = await newTask()
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Description')))
  expect((screen.getByLabelText('Factory') as HTMLSelectElement).value).toBe('f1')
  await user().click(screen.getByRole('button', { name: 'Close' }))
  expect(close).toHaveBeenCalledOnce()
  expect(created).not.toHaveBeenCalled()
})

test('New Task sends a blank title for daemon inference, description, Priority and Start now false', async () => {
  const { created, close } = await newTask()
  const u = user()
  await u.type(
    screen.getByLabelText('Description'),
    'Search ignores accents\nTyping cafe finds Café.',
  )
  await u.selectOptions(screen.getByLabelText('Priority'), 'high')
  await u.click(screen.getByLabelText('Start now'))
  expect(screen.getByText('Waits in Backlog until you start it')).toBeTruthy()
  await u.click(screen.getByRole('button', { name: 'Create' }))
  expect(created).toHaveBeenCalledWith(
    expect.objectContaining({
      factory: 'NB',
      title: '',
      description: 'Search ignores accents\nTyping cafe finds Café.',
      priority: 'high',
      start: false,
    }),
  )
  expect(close).toHaveBeenCalledOnce()
})

test('New Task sends an explicit title and starts by default', async () => {
  const { created } = await newTask()
  const u = user()
  await u.type(screen.getByLabelText('Title'), 'Starts now')
  await u.type(screen.getByLabelText('Description'), 'One')
  await u.click(screen.getByRole('button', { name: 'Create' }))
  expect(created).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'Starts now', start: true }),
  )
})

test('Create more clears both fields, keeps the dialog open and restores focus; a child keeps its parent', async () => {
  const parent = task({ id: 'p', displayId: 'NB-40', title: 'Offline editing' })
  const { created, close } = await newTask({ tasks: [parent], parentId: 'p' })
  const u = user()
  expect(
    await screen.findByText(
      'NB-40 waits for this Task to merge before it does its own remaining work.',
    ),
  ).toBeTruthy()
  await u.type(screen.getByLabelText('Title'), 'First')
  await u.type(screen.getByLabelText('Description'), 'One')
  await u.click(screen.getByRole('button', { name: 'Create more' }))
  expect(created).toHaveBeenCalledOnce()
  expect(created).toHaveBeenCalledWith(expect.objectContaining({ title: 'First', parent: 'p' }))
  expect(await screen.findByText('Offline editing')).toBeTruthy()
  expect(close).not.toHaveBeenCalled()
  expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('')
  expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('')
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Description')))
})

test('More retains Clarify and Task Lead choices when collapsed and submits them', async () => {
  const { created } = await newTask()
  const u = user()
  await screen.findByText('Clarify depth Auto · Task Lead Claude')
  const more = screen.getByRole('button', { name: /^More/ })
  expect(more.getAttribute('aria-expanded')).toBe('false')
  await u.click(more)
  await u.click(screen.getByText('Grill', { exact: true }))
  await u.selectOptions(screen.getByLabelText('Agent'), 'codex')
  await u.selectOptions(screen.getByLabelText('Effort'), 'high')
  await u.click(more)
  expect(screen.getByText('Clarify depth Grill · Task Lead Codex · high')).toBeTruthy()
  await u.type(screen.getByLabelText('Description'), 'Deep one')
  await u.click(more)
  await u.selectOptions(screen.getByLabelText('Model'), 'Other…')
  await u.type(screen.getByLabelText('Model'), 'gpt-5.5')
  await u.keyboard('{Meta>}{Enter}{/Meta}')
  expect(created).not.toHaveBeenCalled()
  expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('gpt-5.5')
  await u.click(screen.getByRole('button', { name: 'Create' }))
  expect(created).toHaveBeenCalledWith(
    expect.objectContaining({
      clarifyDepth: 'grilling',
      lead: { agent: 'codex', model: 'gpt-5.5', effort: 'high' },
    }),
  )
})

test('a blocker from another Factory is sent with its waiting explanation', async () => {
  const created = vi.fn(() => task())
  bridge({
    ...draftHandlers(),
    taskDefaults: () => ({ lead: { agent: 'claude' }, clarifyDepth: 'auto' }),
    createTask: created,
  })
  render(
    <NewTaskDialog
      factories={[factory()]}
      tasks={[
        task({
          id: 'DEV-1',
          displayId: 'DEV-1',
          factoryId: 'other',
          title: 'Crash when search is empty',
        }),
      ]}
      factoryId="f1"
      onClose={vi.fn()}
    />,
  )
  const u = user()
  await formReady()
  await u.click(screen.getByRole('button', { name: 'Add blocker' }))
  await u.type(screen.getByLabelText('Find a Task'), 'crash')
  await u.click(screen.getByRole('option', { name: /DEV-1/ }))
  expect(screen.getByText('Waits as Blocked until DEV-1 merges')).toBeTruthy()
  await u.type(screen.getByLabelText('Description'), 'After the crash fix')
  await u.click(screen.getByRole('button', { name: 'Create' }))
  expect(created).toHaveBeenCalledWith(expect.objectContaining({ blockedBy: ['DEV-1'] }))
})

test('Task Lead saves each pick without a Save button and follows external updates', async () => {
  const save = vi.fn()
  const api = bridge({ setTaskLead: save })
  const view = render(<TaskLeadField task={task()} />)
  const u = user()
  const model = () => screen.getByLabelText('Model') as HTMLSelectElement
  const listed = () => [...model().options].map((option) => option.text)
  expect(listed()).toEqual(['Default model', 'fable', 'opus', 'sonnet', 'haiku', 'Other…'])
  await u.selectOptions(model(), 'opus')
  expect(api.request).toHaveBeenLastCalledWith('setTaskLead', 'NB-1', {
    agent: 'claude',
    model: 'opus',
  })
  await u.selectOptions(screen.getByLabelText('Agent'), 'codex')
  expect(api.request).toHaveBeenLastCalledWith('setTaskLead', 'NB-1', { agent: 'codex' })
  expect(model().value).toBe('')
  expect(listed()).toEqual([
    'Default model',
    'gpt-6-astra',
    'gpt-6.1-sol',
    'gpt-6.1-terra',
    'gpt-6-luna',
    'Other…',
  ])
  await u.selectOptions(model(), 'gpt-6.1-sol')
  const saves = save.mock.calls.length
  await u.selectOptions(model(), 'Other…')
  await u.type(screen.getByLabelText('Model'), 'not-kept{Escape}')
  expect(model().value).toBe('gpt-6.1-sol')
  await u.selectOptions(model(), 'Other…')
  await u.type(screen.getByLabelText('Model'), 'also-not-kept')
  await u.tab()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Back to the list' }))
  await u.keyboard('{Enter}')
  expect(model().value).toBe('gpt-6.1-sol')
  await u.selectOptions(model(), 'Other…')
  expect(save).toHaveBeenCalledTimes(saves)
  await u.type(screen.getByLabelText('Model'), ' gpt-6-mini {Enter}')
  expect(model().value).toBe('gpt-6-mini')
  expect(listed().slice(-2)).toEqual(['gpt-6-mini', 'Other…'])
  expect(api.request).toHaveBeenLastCalledWith('setTaskLead', 'NB-1', {
    agent: 'codex',
    model: 'gpt-6-mini',
  })
  await u.selectOptions(screen.getByLabelText('Effort'), 'low')
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  expect(api.request).toHaveBeenLastCalledWith('setTaskLead', 'NB-1', {
    agent: 'codex',
    model: 'gpt-6-mini',
    effort: 'low',
  })
  view.rerender(
    <TaskLeadField task={task({ lead: { agent: 'codex', model: 'gpt-6-mini', effort: 'low' } })} />,
  )
  expect(screen.getByText('Codex · gpt-6-mini · low')).toBeTruthy()
  view.rerender(<TaskLeadField task={task({ lead: { agent: 'claude', model: 'opus' } })} />)
  expect(model().value).toBe('opus')
  expect((screen.getByLabelText('Agent') as HTMLSelectElement).value).toBe('claude')
  expect((screen.getByLabelText('Effort') as HTMLSelectElement).value).toBe('')
})

test('a pending create disables submission and an error preserves the draft', async () => {
  const pending = deferred<never>()
  bridge({
    ...draftHandlers(),
    taskDefaults: () => ({ clarifyDepth: 'auto', lead: { agent: 'claude' } }),
    createTask: () => pending.promise,
  })
  render(<NewTaskDialog factories={[factory()]} tasks={[]} factoryId="f1" onClose={vi.fn()} />)
  await formReady()
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Keep this' } })
  await user().click(screen.getByRole('button', { name: 'Create' }))
  expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => pending.reject(new Error('Couldn’t create')))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Couldn’t create')
  await waitFor(() =>
    expect((screen.getByLabelText('Description') as HTMLInputElement).value).toBe('Keep this'),
  )
})

test('files dropped anywhere on the dialog while the draft loads show the overlay and are attached once it has loaded', async () => {
  const draft = deferred<{ draft: null }>()
  const uploaded = vi.fn((file: unknown) => ({
    hash: 'abc',
    name: (file as { name: string }).name,
    mediaType: 'text/plain',
    size: 5,
  }))
  bridge({
    ...draftHandlers(),
    taskDraft: () => draft.promise,
    taskDefaults: () => ({ clarifyDepth: 'auto', lead: { agent: 'claude' } }),
    uploadAttachment: uploaded,
  })
  render(<NewTaskDialog factories={[factory()]} tasks={[]} factoryId="f1" onClose={vi.fn()} />)
  expect(screen.getByLabelText('Description').matches(':disabled')).toBe(true)
  const description = screen.getByLabelText('Description')
  fireEvent.dragOver(description, { dataTransfer: { types: ['text/plain'] } })
  expect(screen.queryByText('Drop to attach')).toBeNull()
  fireEvent.dragOver(description, { dataTransfer: { types: ['Files'] } })
  expect(screen.getByText('Drop to attach')).toBeTruthy()
  fireEvent.dragLeave(description, { relatedTarget: null })
  expect(screen.queryByText('Drop to attach')).toBeNull()
  fireEvent.dragOver(description, { dataTransfer: { types: ['Files'] } })
  fireEvent.drop(description, {
    dataTransfer: {
      types: ['Files'],
      files: [new File(['hello'], 'notes.txt', { type: 'text/plain' })],
    },
  })
  expect(screen.queryByText('Drop to attach')).toBeNull()
  expect(await screen.findByText('Attaching…')).toBeTruthy()
  expect(uploaded).not.toHaveBeenCalled()
  await act(async () => draft.resolve({ draft: null }))
  expect(await screen.findByRole('button', { name: 'Remove notes.txt' })).toBeTruthy()
  expect(uploaded).toHaveBeenCalledWith(
    { name: 'notes.txt', mediaType: 'text/plain' },
    expect.any(Uint8Array),
  )
  expect(screen.queryByText('Attaching…')).toBeNull()
})

test('the attach box opens the file picker from anywhere on it while the draft and agent health load', async () => {
  const draft = deferred<{ draft: null }>()
  const health = deferred<never>()
  const uploaded = vi.fn((file: unknown) => ({
    hash: 'abc',
    name: (file as { name: string }).name,
    mediaType: 'text/plain',
    size: 5,
  }))
  bridge({
    ...draftHandlers(),
    taskDraft: () => draft.promise,
    taskDefaults: () => ({ clarifyDepth: 'auto', lead: { agent: 'claude' } }),
    checkAgentHealth: () => health.promise,
    uploadAttachment: uploaded,
  })
  render(<NewTaskDialog factories={[factory()]} tasks={[]} factoryId="f1" onClose={vi.fn()} />)
  expect(screen.getByLabelText('Description').matches(':disabled')).toBe(true)
  const input = screen.getByLabelText('Attach files')
  const picker = vi.spyOn(input, 'click')
  const u = user()
  await u.click(screen.getByRole('group', { name: 'Attachments' }))
  expect(picker).toHaveBeenCalledOnce()
  await u.click(screen.getByRole('button', { name: 'Drop files here, or click to attach' }))
  expect(picker).toHaveBeenCalledTimes(2)
  fireEvent.change(input, {
    target: { files: [new File(['hello'], 'notes.txt', { type: 'text/plain' })] },
  })
  expect(await screen.findByText('Attaching…')).toBeTruthy()
  expect(uploaded).not.toHaveBeenCalled()
  await act(async () => draft.resolve({ draft: null }))
  expect(await screen.findByRole('button', { name: 'Remove notes.txt' })).toBeTruthy()
  expect(uploaded).toHaveBeenCalledOnce()
  expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(true)
})

test('an edit made before the defaults arrive keeps the Factory’s Clarify depth', async () => {
  const health = deferred<ReturnType<ReturnType<typeof draftHandlers>['checkAgentHealth']>>()
  const created = vi.fn(() => task())
  bridge({
    ...draftHandlers(),
    taskDefaults: () => ({ clarifyDepth: 'grilling', lead: { agent: 'claude' } }),
    checkAgentHealth: () => health.promise,
    createTask: created,
  })
  render(<NewTaskDialog factories={[factory()]} tasks={[]} factoryId="f1" onClose={vi.fn()} />)
  await waitFor(() => expect(screen.getByLabelText('Description').matches(':disabled')).toBe(false))
  const u = user()
  await u.type(screen.getByLabelText('Description'), 'Typed early')
  const more = screen.getByRole('button', { name: /^More/ })
  await u.click(more)
  expect((screen.getByRole('radio', { name: 'Auto' }) as HTMLInputElement).disabled).toBe(true)
  await act(async () => health.resolve(draftHandlers().checkAgentHealth()))
  await waitFor(() =>
    expect((screen.getByRole('radio', { name: 'Grill' }) as HTMLInputElement).checked).toBe(true),
  )
  expect((screen.getByRole('radio', { name: 'Auto' }) as HTMLInputElement).disabled).toBe(false)
  await u.click(more)
  await screen.findByText('Clarify depth Grill · Task Lead Claude')
  await u.click(screen.getByRole('button', { name: 'Create' }))
  expect(created).toHaveBeenCalledWith(expect.objectContaining({ clarifyDepth: 'grilling' }))
})

test('Model unavailable offers the default model and sends the human’s choice', async () => {
  const run: import('@ted/protocol').Run = {
    id: 'r1',
    agent: 'claude',
    permissions: 'auto',
    prompt: '',
    cwd: '/test',
    state: 'idle',
    startedAt: createdAt,
  }
  const api = bridge({
    getRun: () => ({ run: { ...run, problem: 'model-unavailable' }, conversation: [] }),
    useDefaultModel: vi.fn(),
  })
  render(
    <TaskLeadField
      task={task({ leadRunId: 'r1', lead: { agent: 'claude', model: 'unavailable-9' } })}
    />,
  )
  await screen.findByText('Model unavailable')
  await user().click(screen.getByRole('button', { name: 'Use the default model' }))
  expect(api.request).toHaveBeenCalledWith('useDefaultModel', 'NB-1')
  await act(async () => api.emit({ type: 'run-updated', run }))
  expect(screen.queryByText('Model unavailable')).toBeNull()
})

test('Restart now shows only while the live Task Lead differs from the saved choice', async () => {
  const run: import('@ted/protocol').Run = {
    id: 'r1',
    agent: 'claude',
    effort: 'low',
    permissions: 'auto',
    prompt: '',
    cwd: '/test',
    state: 'working',
    startedAt: createdAt,
  }
  const api = bridge({
    getRun: () => ({ run, conversation: [] }),
    restartTaskLead: vi.fn(),
  })
  const view = render(
    <TaskLeadField
      task={task({ stage: 'work', leadRunId: 'r1', lead: { agent: 'claude', effort: 'low' } })}
    />,
  )
  await act(async () => api.emit({ type: 'run-updated', run }))
  expect(screen.queryByRole('button', { name: 'Restart now to apply changes' })).toBeNull()
  view.rerender(
    <TaskLeadField
      task={task({ stage: 'work', leadRunId: 'r1', lead: { agent: 'claude', effort: 'high' } })}
    />,
  )
  await user().click(screen.getByRole('button', { name: 'Restart now to apply changes' }))
  expect(api.request).toHaveBeenCalledWith('restartTaskLead', 'NB-1')
  await act(async () => api.emit({ type: 'run-updated', run: { ...run, effort: 'high' } }))
  expect(screen.queryByRole('button', { name: 'Restart now to apply changes' })).toBeNull()
})

test('following Stage effort survives a model edit and can be replaced with explicit CLI default', async () => {
  const api = bridge({ setTaskLead: () => task() })
  render(
    <TaskLeadField
      task={task({
        lead: { agent: 'claude', model: 'opus', effort: 'medium', effortMode: 'stage' },
        stageEffort: 'high',
      })}
    />,
  )
  expect((screen.getByLabelText('Effort') as HTMLSelectElement).value).toBe('stage')
  const u = user()
  await u.selectOptions(screen.getByLabelText('Model'), 'sonnet')
  expect(api.request).toHaveBeenLastCalledWith('setTaskLead', expect.any(String), {
    agent: 'claude',
    model: 'sonnet',
    effort: 'medium',
    effortMode: 'stage',
  })
  await u.selectOptions(screen.getByLabelText('Effort'), '')
  expect(api.request).toHaveBeenLastCalledWith('setTaskLead', expect.any(String), {
    agent: 'claude',
    model: 'sonnet',
  })
})

test.each(['stage', 'high', ''] as const)(
  'New Task fallback follows Stages unless effort is explicitly %s',
  async (effort) => {
    const created = vi.fn(() => task())
    bridge({
      ...draftHandlers(),
      taskDefaults: () => ({
        lead: { agent: 'claude', effort: 'medium', effortMode: 'stage' },
        clarifyDepth: 'auto',
      }),
      checkAgentHealth: () => [
        { agent: 'claude', state: 'not-installed' },
        { agent: 'codex', state: 'ready', version: '2.0.0' },
        { agent: 'antigravity', state: 'not-installed' },
      ],
      createTask: created,
    })
    render(<NewTaskDialog factories={[factory()]} tasks={[]} factoryId="f1" onClose={() => {}} />)
    const u = user()
    await formReady()
    await u.click(screen.getByRole('button', { name: /^More/ }))
    await waitFor(() =>
      expect((screen.getByLabelText('Agent') as HTMLSelectElement).value).toBe('codex'),
    )
    if (effort === 'stage')
      expect((screen.getByLabelText('Effort') as HTMLSelectElement).value).toBe('stage')
    else await u.selectOptions(screen.getByLabelText('Effort'), effort)
    await u.type(
      screen.getByLabelText('Description'),
      'Use the configured Stage effort with the installed agent.',
    )
    await u.click(screen.getByRole('button', { name: 'Create' }))
    expect(created).toHaveBeenCalledWith(
      expect.objectContaining({
        lead: {
          agent: 'codex',
          ...(effort === 'stage' ? { effortMode: 'stage' } : effort !== '' ? { effort } : {}),
        },
      }),
    )
  },
)
