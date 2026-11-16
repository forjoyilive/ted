// @vitest-environment jsdom
import type { Automation, AutomationDetail, FactorySettingsView } from '@ted/protocol'
import { defaultMachineSettings } from '@ted/protocol/settings'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useId, useState } from 'react'
import { expect, test, vi } from 'vitest'
import { ActionButton } from '../src/renderer/components/ActionButton.tsx'
import { DeleteDialog } from '../src/renderer/components/ArchiveDialogs.tsx'
import { Button } from '../src/renderer/components/Button.tsx'
import { buttonPosition, useActionMenu } from '../src/renderer/components/ContextMenu.tsx'
import { Markdown } from '../src/renderer/components/Markdown.tsx'
import { Composer } from '../src/renderer/components/RunChat.tsx'
import { useFactoryList } from '../src/renderer/data.ts'
import { settingsDraft } from '../src/renderer/factory-settings.ts'
import { useTaskFiles } from '../src/renderer/files.ts'
import { usePendingAction } from '../src/renderer/pending-action.ts'
import { Button as SettingsButton, Stepper } from '../src/renderer/settings/controls.tsx'
import { AutomationsPage, AutomationView } from '../src/renderer/views/Automations.tsx'
import { EditTaskDialog } from '../src/renderer/views/EditTaskDialog.tsx'
import { ChecksSection } from '../src/renderer/views/FactorySettingsSections.tsx'
import { FirstLaunch } from '../src/renderer/views/FirstLaunch.tsx'
import { bridge, deferred, required, user } from './support/component.ts'
import { factory, task } from './support/fixtures.ts'

function Save({ action }: { action: () => Promise<void> }) {
  const [saving, setSaving] = useState(false)
  return (
    <Button
      shortcut="⌘S"
      onClick={() => {
        setSaving(true)
        return action().finally(() => setSaving(false))
      }}
    >
      {saving ? 'Saving…' : 'Save'}
    </Button>
  )
}

test('a pending button retains its name and resting content, rejects repeats, and clears on completion', async () => {
  const completion = deferred<void>()
  const action = vi.fn(() => completion.promise)
  render(
    <>
      <Save action={action} />
      <Button onClick={vi.fn()}>Unrelated</Button>
    </>,
  )
  const button = screen.getByRole('button', { name: 'Save' })
  fireEvent.click(button)
  expect(button.getAttribute('aria-busy')).toBe('true')
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(screen.getByRole('button', { name: 'Save' })).toBe(button)
  expect(button.textContent).toContain('Save')
  expect(button.textContent).not.toContain('Saving…')
  expect(button.querySelector('[aria-hidden]')).not.toBeNull()
  fireEvent.click(button)
  expect(action).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Unrelated' }).getAttribute('aria-busy')).toBeNull()
  await act(async () => completion.resolve())
  expect(button.getAttribute('aria-busy')).toBeNull()
  expect(button.getAttribute('aria-disabled')).toBeNull()
})

test('an unhandled rejection is readable, clears pending and permits retry', async () => {
  const completion = deferred<void>()
  const action = vi.fn().mockReturnValueOnce(completion.promise).mockResolvedValue(undefined)
  render(<SettingsButton onClick={action}>Connect</SettingsButton>)
  const button = screen.getByRole('button', { name: 'Connect' })
  await user().click(button)
  await act(async () => completion.reject(new Error('Connection failed')))
  expect(screen.getByRole('alert').textContent).toBe('Connection failed')
  expect(button.getAttribute('aria-busy')).toBeNull()
  await user().click(button)
  expect(action).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('alert')).toBeNull()
})

test('an icon action keeps its accessible name and starts from the keyboard', async () => {
  const completion = deferred<void>()
  render(
    <ActionButton aria-label="Copy command" onClick={() => completion.promise}>
      <span aria-hidden>⧉</span>
    </ActionButton>,
  )
  const button = screen.getByRole('button', { name: 'Copy command' })
  button.focus()
  await user().keyboard('{Enter}')
  expect(button.getAttribute('aria-busy')).toBe('true')
  expect(document.activeElement).toBe(button)
  await act(async () => completion.resolve())
  expect(button.getAttribute('aria-busy')).toBeNull()
})

test('synchronous actions keep their normal content without activity', () => {
  const choose = vi.fn()
  render(<Button onClick={choose}>Edit…</Button>)
  const button = screen.getByRole('button', { name: 'Edit…' })
  fireEvent.click(button)
  expect(choose).toHaveBeenCalledOnce()
  expect(button.getAttribute('aria-busy')).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
})

function ActionMenu({ run }: { run: () => unknown }) {
  const id = useId()
  const menu = useActionMenu(`activity-test:${id}`)
  return (
    <>
      <Button
        onClick={(event) =>
          menu.open(buttonPosition(event.currentTarget), 'Actions', [
            { label: 'Run now', action: run },
            { label: 'Edit…', action: () => undefined },
          ])
        }
      >
        Actions
      </Button>
      {menu.menu}
    </>
  )
}

test('a menu action stays visible pending, survives dismissal, and closes on success', async () => {
  const completion = deferred<void>()
  const run = vi.fn(() => completion.promise)
  render(<ActionMenu run={run} />)
  const u = user()
  await u.click(screen.getByRole('button', { name: 'Actions' }))
  await u.click(screen.getByRole('menuitem', { name: 'Run now' }))
  expect(screen.getByRole('menu')).toBeTruthy()
  expect(screen.getByRole('menuitem', { name: 'Run now' }).getAttribute('aria-busy')).toBe('true')
  expect((screen.getByRole('menuitem', { name: 'Edit…' }) as HTMLButtonElement).disabled).toBe(true)
  await u.keyboard('{Escape}')
  expect(screen.queryByRole('menu')).toBeNull()
  await u.click(screen.getByRole('button', { name: 'Actions' }))
  const reopened = screen.getByRole('menuitem', { name: 'Run now' })
  expect(reopened.getAttribute('aria-busy')).toBe('true')
  fireEvent.click(reopened)
  expect(run).toHaveBeenCalledOnce()
  await act(async () => completion.resolve())
  expect(screen.queryByRole('menu')).toBeNull()
})

test('a rejected menu action stays available with an error for retry', async () => {
  const completion = deferred<void>()
  const run = vi.fn().mockReturnValueOnce(completion.promise).mockResolvedValue(undefined)
  render(<ActionMenu run={run} />)
  const u = user()
  await u.click(screen.getByRole('button', { name: 'Actions' }))
  await u.click(screen.getByRole('menuitem', { name: 'Run now' }))
  await act(async () => completion.reject(new Error('Couldn’t start')))
  expect(screen.getByRole('alert').textContent).toContain('Couldn’t start')
  await u.click(screen.getByRole('menuitem', { name: 'Run now' }))
  expect(run).toHaveBeenCalledTimes(2)
})

function PersistentControl({ run }: { run: () => unknown }) {
  const activity = usePendingAction('persistent-operation-test')
  return (
    <Button pending={activity.pending} onClick={() => activity.run(run)}>
      Start
    </Button>
  )
}

test('an operation keyed to a resource cannot submit twice across an unmount', async () => {
  const completion = deferred<void>()
  const run = vi.fn(() => completion.promise)
  const first = render(<PersistentControl run={run} />)
  fireEvent.click(screen.getByRole('button', { name: 'Start' }))
  first.unmount()
  render(<PersistentControl run={run} />)
  const button = screen.getByRole('button', { name: 'Start' })
  expect(button.getAttribute('aria-busy')).toBe('true')
  fireEvent.click(button)
  expect(run).toHaveBeenCalledOnce()
  await act(async () => completion.resolve())
  expect(button.getAttribute('aria-busy')).toBeNull()
})

test('a stepper pauses both directions until its setting save finishes', async () => {
  const completion = deferred<void>()
  const change = vi.fn(() => completion.promise)
  render(<Stepper value={2} min={0} max={4} lessLabel="Less" moreLabel="More" onChange={change} />)
  const more = screen.getByRole('button', { name: 'More' })
  fireEvent.click(more)
  fireEvent.click(more)
  fireEvent.click(screen.getByRole('button', { name: 'Less' }))
  expect(change).toHaveBeenCalledExactlyOnceWith(3)
  expect(more.getAttribute('aria-busy')).toBe('true')
  await act(async () => completion.resolve())
})

test('keyboard chat submission shows pending on Send and keeps the draft after a rejection', async () => {
  const completion = deferred<void>()
  const send = vi.fn(() => completion.promise)
  render(
    <Composer
      live
      working={false}
      placeholder="Message"
      endedPlaceholder="Ended"
      help="Send a message"
      send={send}
      stopTurn={vi.fn()}
    />,
  )
  const u = user()
  await u.type(screen.getByRole('textbox'), 'Keep this draft{Enter}')
  const button = screen.getByRole('button', { name: 'Send' })
  expect(button.getAttribute('aria-busy')).toBe('true')
  fireEvent.click(button)
  expect(send).toHaveBeenCalledExactlyOnceWith('Keep this draft', false)
  await act(async () => completion.reject(new Error('Couldn’t send')))
  expect(screen.getByRole('alert').textContent).toBe('Couldn’t send')
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Keep this draft')
  expect(button.getAttribute('aria-busy')).toBeNull()
})

test('Check Run now acknowledges before a remote running state and restores after rejection', async () => {
  const completion = deferred<never>()
  const run = vi.fn(() => completion.promise)
  bridge({ tryCheck: run })
  const view: FactorySettingsView = {
    factoryId: 'factory',
    repo: 'acme/widgets',
    defaultBranch: 'main',
    source: 'file',
    version: '1',
    repos: [],
    problems: [],
    github: { ready: true },
    stages: [],
    ignoredStageFiles: [],
    checks: [],
    cleanup: { enabled: false, steps: [] },
    tries: [],
    agents: [],
    permissions: 'auto',
    machineMaxWorkingRuns: 6,
    notes: '',
  }
  const draft = {
    ...settingsDraft(view),
    checks: [
      { name: 'Typecheck', run: 'pnpm typecheck' },
      { name: 'Lint', run: 'pnpm lint' },
    ],
  }
  render(<ChecksSection view={view} draft={draft} tries={[]} onDraft={vi.fn()} />)
  const buttons = screen.getAllByRole('button', { name: 'Run now' })
  const button = required(buttons[0])
  await user().click(button)
  expect(button.getAttribute('aria-busy')).toBe('true')
  fireEvent.click(button)
  fireEvent.click(required(buttons[1]))
  expect(run).toHaveBeenCalledTimes(1)
  expect((buttons[1] as HTMLButtonElement).disabled).toBe(true)
  await act(async () => completion.reject(new Error('Couldn’t prepare Check')))
  expect(screen.getByRole('alert').textContent).toBe('Couldn’t prepare Check')
  expect(button.getAttribute('aria-busy')).toBeNull()
  expect((button as HTMLButtonElement).disabled).toBe(false)
})

test('Automation Run now shows pending and prevents duplicate firings before its response', async () => {
  const completion = deferred<unknown>()
  const run = vi.fn(() => completion.promise)
  const detail: AutomationDetail = {
    automation: {
      id: 'activity-automation',
      factoryId: 'f1',
      factoryKey: 'NB',
      name: 'Weekly triage',
      prompt: 'Triage requests.',
      schedule: { kind: 'weekly', days: ['mon'], at: '09:00' },
      timeZone: 'UTC',
      scheduleText: 'Every Monday',
      agent: 'claude',
      on: false,
      createdAt: '2026-11-11T12:00:00Z',
      nextFirings: [],
      failuresInARow: 0,
      totals: { runs: 0, tasksCreated: 0 },
    },
    history: [],
    requests: [],
  }
  bridge({ getAutomation: () => detail, runAutomation: run })
  render(
    <AutomationView
      automationId="activity-automation"
      banners={null}
      settings={undefined}
      onBack={vi.fn()}
      onOpenRun={vi.fn()}
      onEdit={vi.fn()}
      onOpenAutomation={vi.fn()}
      onOpenTask={vi.fn()}
    />,
  )
  await screen.findByRole('heading', { name: 'Weekly triage' })
  const button = screen.getByRole('button', { name: 'Run now' })
  await user().click(button)
  expect(button.getAttribute('aria-busy')).toBe('true')
  fireEvent.click(button)
  expect(run).toHaveBeenCalledOnce()
  expect((screen.getByRole('button', { name: 'Edit…' }) as HTMLButtonElement).disabled).toBe(true)
  await user().click(screen.getByRole('button', { name: 'Automation actions' }))
  const menuRun = screen.getByRole('menuitem', { name: 'Run now' })
  expect(menuRun.getAttribute('aria-busy')).toBe('true')
  fireEvent.click(menuRun)
  expect(run).toHaveBeenCalledOnce()
  await user().keyboard('{Escape}')
  await act(async () => completion.resolve({}))
  await waitFor(() => expect(button.getAttribute('aria-busy')).toBeNull())
})

const filesTask = task({
  repos: [
    {
      name: 'web',
      repo: 'acme/web',
      worktree: '/w/web',
      branch: 'task-branch',
      copied: [],
      skipped: [],
    },
  ],
})
function FileRefresh() {
  const files = useTaskFiles(filesTask, true)
  return (
    <>
      <Button onClick={files.refresh}>Refresh files</Button>
      <span>{files.files?.repos.length ?? 0} repos</span>
    </>
  )
}

test('an effect-driven file refresh keeps its button pending until the new request settles', async () => {
  const completion = deferred<unknown>()
  const api = bridge({
    taskFiles: () => ({
      taskId: filesTask.id,
      repos: [{ repo: 'web', paths: [], partial: false }],
    }),
  })
  render(<FileRefresh />)
  await screen.findByText('1 repos')
  api.handle('taskFiles', () => completion.promise)
  const button = screen.getByRole('button', { name: 'Refresh files' })
  await user().click(button)
  expect(button.getAttribute('aria-busy')).toBe('true')
  expect(screen.getByText('1 repos')).toBeTruthy()
  fireEvent.click(button)
  expect(api.request.mock.calls.filter(([name]) => name === 'taskFiles')).toHaveLength(2)
  await act(async () => completion.resolve({ taskId: filesTask.id, repos: [] }))
  expect(screen.getByText('0 repos')).toBeTruthy()
  expect(button.getAttribute('aria-busy')).toBeNull()
})

test('the code-copy button from main retains its icon box and shows activity until the copy finishes', async () => {
  const completion = deferred<void>()
  const copy = vi.fn(() => completion.promise)
  bridge({ copyText: copy })
  render(<Markdown text={'```sh\npnpm typecheck\n```'} />)
  const button = screen.getByRole('button', { name: 'Copy code' })
  await user().click(button)
  expect(button.getAttribute('aria-busy')).toBe('true')
  fireEvent.click(button)
  expect(copy).toHaveBeenCalledTimes(1)
  await act(async () => completion.resolve())
  expect(button.getAttribute('aria-busy')).toBeNull()
  expect(screen.getByText('Copied')).toBeTruthy()
})

function FactoryList() {
  const resource = useFactoryList()
  return (
    <span>
      {resource.loaded ? resource.factories.map((f) => f.name).join(', ') : 'Loading Factories'}
    </span>
  )
}

test('automatic Factory retry survives the merge with effect-driven action completion', async () => {
  vi.useFakeTimers()
  try {
    const completion = deferred<unknown>()
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error('Busy'))
      .mockReturnValue(completion.promise)
    bridge({ listFactories: list })
    render(<FactoryList />)
    await act(async () => {})
    expect(screen.getByText('Loading Factories')).toBeTruthy()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(list).toHaveBeenCalledTimes(2)
    await act(async () => completion.resolve([factory({ name: 'Widgets' })]))
    expect(screen.getByText('Widgets')).toBeTruthy()
  } finally {
    vi.useRealTimers()
  }
})

test('keyboard Task edits show the same pending state, reject repeats and recover', async () => {
  const completion = deferred<void>()
  const edit = vi.fn(() => completion.promise)
  bridge({ editTask: edit })
  render(<EditTaskDialog task={task()} onClose={vi.fn()} />)
  const description = screen.getByRole('textbox', { name: 'Description' })
  fireEvent.change(description, { target: { value: 'Revised description' } })
  fireEvent.keyDown(description, { key: 'Enter', metaKey: true })
  const save = screen.getByRole('button', { name: /Save/ })
  expect(save.getAttribute('aria-busy')).toBe('true')
  fireEvent.keyDown(description, { key: 'Enter', metaKey: true })
  fireEvent.click(save)
  expect(edit).toHaveBeenCalledOnce()
  await act(async () => completion.reject(new Error('Couldn’t save edit')))
  expect(save.getAttribute('aria-busy')).toBeNull()
  expect(screen.getByRole('alert').textContent).toBe('Couldn’t save edit')
})

test('deletion pauses Archive instead and dismissal until an error restores the choices', async () => {
  const completion = deferred<void>()
  const remove = vi.fn(() => completion.promise)
  const close = vi.fn()
  const archive = vi.fn()
  bridge({ listTasks: () => [], listTaskRuns: () => [], deleteTask: remove })
  render(<DeleteDialog task={task()} onClose={close} onArchiveInstead={archive} />)
  const button = screen.getByRole('button', { name: 'Delete NB-1' })
  await user().click(button)
  expect(button.getAttribute('aria-busy')).toBe('true')
  const instead = screen.getByRole('button', { name: 'Archive instead' })
  expect((instead as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(instead)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
  expect(archive).not.toHaveBeenCalled()
  expect(close).not.toHaveBeenCalled()
  fireEvent.click(button)
  expect(remove).toHaveBeenCalledOnce()
  await act(async () => completion.reject(new Error('Couldn’t delete')))
  expect((instead as HTMLButtonElement).disabled).toBe(false)
  expect(screen.getByRole('alert').textContent).toBe('Couldn’t delete')
})

test('first-launch Git identity copy waits for the clipboard and exposes errors for retry', async () => {
  const completion = deferred<void>()
  const copy = vi.fn().mockReturnValueOnce(completion.promise).mockResolvedValue(undefined)
  bridge({
    agentHealth: () => [],
    getIntegrations: () => ({
      github: { cli: { state: 'ready' }, hosts: [] },
      git: { state: 'no-identity', copy: ['git config --global user.name Example'] },
      checkedAt: '2026-11-11T12:00:00Z',
    }),
    copyText: copy,
  })
  render(
    <FirstLaunch
      settings={defaultMachineSettings}
      startAtLogin={false}
      onStartAtLogin={vi.fn()}
      reporting
      onReporting={vi.fn()}
      footer={() => null}
    />,
  )
  const git = within(await screen.findByRole('group', { name: 'Git' }))
  const button = await git.findByRole('button', { name: 'Copy' })
  await user().click(button)
  expect(button.getAttribute('aria-busy')).toBe('true')
  fireEvent.click(button)
  expect(copy).toHaveBeenCalledOnce()
  await act(async () => completion.reject(new Error('Clipboard unavailable')))
  expect(button.getAttribute('aria-busy')).toBeNull()
  expect(git.getByRole('alert').textContent).toBe('Clipboard unavailable')
  await user().click(button)
  expect(copy).toHaveBeenCalledTimes(2)
})

test('pending Automation menus follow their resource and completion does not close another menu', async () => {
  const first = deferred<void>()
  const second = deferred<void>()
  const automations: Automation[] = ['A', 'B'].map((id) => ({
    id: `independent-${id}`,
    factoryId: 'f1',
    factoryKey: 'NB',
    name: `Automation ${id}`,
    prompt: 'Triage requests.',
    schedule: { kind: 'weekly', days: ['mon'], at: '09:00' },
    timeZone: 'UTC',
    scheduleText: 'Every Monday',
    agent: 'claude',
    on: false,
    createdAt: '2026-11-11T12:00:00Z',
    nextFirings: [],
    failuresInARow: 0,
    totals: { runs: 0, tasksCreated: 0 },
  }))
  const run = vi.fn((id) => (id === 'independent-A' ? first.promise : second.promise))
  bridge({ listAutomations: () => automations, automationTemplates: () => [], runAutomation: run })
  render(
    <AutomationsPage
      factory={factory()}
      banners={null}
      onOpen={vi.fn()}
      onNew={vi.fn()}
      onEdit={vi.fn()}
      onOpenTask={vi.fn()}
    />,
  )
  const a = await screen.findByRole('button', { name: 'Automation A' })
  const b = screen.getByRole('button', { name: 'Automation B' })
  fireEvent.contextMenu(a)
  await user().click(screen.getByRole('menuitem', { name: 'Run now' }))
  await user().keyboard('{Escape}')
  fireEvent.contextMenu(b)
  const runB = screen.getByRole('menuitem', { name: 'Run now' })
  expect(runB.getAttribute('aria-busy')).toBeNull()
  expect(runB.matches(':disabled')).toBe(false)
  await user().click(runB)
  expect(run).toHaveBeenNthCalledWith(1, 'independent-A')
  expect(run).toHaveBeenNthCalledWith(2, 'independent-B')
  await act(async () => first.resolve())
  expect(screen.getByRole('menu', { name: 'Automation B' })).toBeTruthy()
  expect(runB.getAttribute('aria-busy')).toBe('true')
  await act(async () => second.resolve())
  expect(screen.queryByRole('menu')).toBeNull()
})
