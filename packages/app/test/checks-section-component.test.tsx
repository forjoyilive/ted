// @vitest-environment jsdom
import type { CheckTry, FactorySettingsView } from '@ted/protocol'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { expect, test, vi } from 'vitest'
import { type SettingsDraft, settingsDraft } from '../src/renderer/factory-settings.ts'
import { ChecksSection } from '../src/renderer/views/FactorySettingsSections.tsx'
import { bridge, deferred, user } from './support/component.ts'
import { task } from './support/fixtures.ts'

const view: FactorySettingsView = {
  agentFiles: [],
  factoryId: 'f1',
  repo: 'acme/widgets',
  defaultBranch: 'main',
  source: 'file',
  version: '1',
  repos: [],
  problems: [],
  github: { ready: true },
  stages: [],
  ignoredStageFiles: [],
  checks: [
    { was: 0, name: 'Typecheck', run: 'pnpm typecheck' },
    { was: 1, name: 'Lint', run: 'pnpm lint', timeout: '5m' },
  ],
  instructionChecks: [
    { was: 2, name: 'Docs drift', instruction: 'Fix stale docs.\nName each one.', fix: true },
    { was: 3, name: 'Copy', instruction: 'Check the UI text.' },
  ],
  cleanup: { enabled: false, steps: [] },
  tries: [],
  agents: [
    {
      role: 'reviewer',
      own: { agent: 'codex' },
      inherited: { agent: 'claude' },
      inheritedFrom: 'ted',
      from: 'factory',
    },
  ],
  permissions: 'auto',
  machineMaxWorkingRuns: 6,
  notes: '',
}

function Section({
  tries = [],
  onChange,
}: {
  tries?: CheckTry[]
  onChange?: (draft: SettingsDraft) => void
}) {
  const [draft, setDraft] = useState(() => settingsDraft(view))
  return (
    <ChecksSection
      view={view}
      draft={draft}
      tries={tries}
      onDraft={(change) =>
        setDraft((current) => {
          const next = change(current)
          onChange?.(next)
          return next
        })
      }
    />
  )
}

const list = (name: string) => within(screen.getByRole('list', { name }))
const names = (name: string) =>
  list(name)
    .getAllByRole('listitem')
    .map((item) => item.getAttribute('aria-label'))
const row = (listName: string, name: string) =>
  within(list(listName).getByRole('listitem', { name }))

test('Checks show as collapsed rows in two lists, and one editor opens at a time', async () => {
  bridge({})
  const u = user()
  render(<Section />)
  expect(names('Command Checks')).toEqual(['Typecheck', 'Lint'])
  expect(names('Instruction Checks')).toEqual(['Docs drift', 'Copy'])
  const docs = row('Instruction Checks', 'Docs drift')
  expect(docs.getByText('may fix')).toBeTruthy()
  expect(docs.getByText('Fix stale docs.')).toBeTruthy()
  expect(row('Instruction Checks', 'Copy').queryByText('may fix')).toBeNull()
  expect(row('Command Checks', 'Typecheck').getByText('10m')).toBeTruthy()
  expect(row('Command Checks', 'Lint').getByText('5m')).toBeTruthy()
  expect(screen.queryByRole('textbox')).toBeNull()

  await u.click(row('Command Checks', 'Lint').getByRole('button', { name: 'Edit' }))
  expect((screen.getByLabelText('Command') as HTMLInputElement).value).toBe('pnpm lint')
  await u.click(docs.getByRole('button', { name: 'Edit' }))
  expect(screen.queryByLabelText('Command')).toBeNull()
  expect(row('Command Checks', 'Lint').getByRole('button', { name: 'Edit' })).toBeTruthy()
  expect((screen.getByLabelText('Instruction for the agent') as HTMLTextAreaElement).value).toBe(
    'Fix stale docs.\nName each one.',
  )
  expect(
    (screen.getByRole('checkbox', { name: 'May fix what it finds' }) as HTMLInputElement).checked,
  ).toBe(true)
  expect(screen.getByRole('option', { name: 'Reviewer’s (Codex)' })).toBeTruthy()
  await u.click(docs.getByRole('button', { name: 'Close' }))
  expect(screen.queryByLabelText('Instruction for the agent')).toBeNull()
})

test('an added instruction Check opens with its name focused and saves its fields', async () => {
  bridge({})
  const u = user()
  const onChange = vi.fn<(draft: SettingsDraft) => void>()
  render(<Section onChange={onChange} />)
  await u.click(screen.getByRole('button', { name: '+ Add instruction Check' }))
  expect(document.activeElement).toBe(screen.getByLabelText('Name'))
  await u.type(screen.getByLabelText('Name'), 'Tests named')
  await u.type(screen.getByLabelText('Instruction for the agent'), 'Name the tests.')
  await u.click(screen.getByRole('checkbox', { name: 'May fix what it finds' }))
  await u.selectOptions(screen.getByLabelText('Effort'), 'high')
  expect(row('Instruction Checks', 'Tests named').getByText('may fix')).toBeTruthy()
  expect(onChange.mock.lastCall?.[0].instructionChecks.at(-1)).toEqual({
    name: 'Tests named',
    instruction: 'Name the tests.',
    fix: true,
    effort: 'high',
  })
  await u.click(screen.getByRole('checkbox', { name: 'May fix what it finds' }))
  await u.selectOptions(screen.getByLabelText('Effort'), 'Reviewer’s effort')
  expect(onChange.mock.lastCall?.[0].instructionChecks.at(-1)).toEqual({
    name: 'Tests named',
    instruction: 'Name the tests.',
  })
  await u.click(screen.getByRole('button', { name: 'Remove' }))
  expect(names('Instruction Checks')).toEqual(['Docs drift', 'Copy'])

  await u.click(screen.getByRole('button', { name: '+ Add command Check' }))
  expect(document.activeElement).toBe(screen.getByLabelText('Name'))
  expect(names('Command Checks')).toEqual(['Typecheck', 'Lint', 'New command Check'])
})

test('a handle reorders its row with the arrow keys or by dragging, only within its own list', async () => {
  bridge({})
  const u = user()
  const onChange = vi.fn<(draft: SettingsDraft) => void>()
  render(<Section onChange={onChange} />)
  const handle = (listName: string, name: string) =>
    row(listName, name).getByRole('button', { name: 'Drag to reorder, or use the arrow keys' })

  handle('Command Checks', 'Typecheck').focus()
  await u.keyboard('{ArrowDown}')
  expect(names('Command Checks')).toEqual(['Lint', 'Typecheck'])
  expect(document.activeElement).toBe(handle('Command Checks', 'Typecheck'))
  await u.keyboard('{ArrowDown}')
  expect(names('Command Checks')).toEqual(['Lint', 'Typecheck'])
  await u.keyboard('{ArrowUp}')
  expect(names('Command Checks')).toEqual(['Typecheck', 'Lint'])
  expect(onChange.mock.lastCall?.[0].checks.map((c) => c.was)).toEqual([0, 1])

  const drag = { dataTransfer: { effectAllowed: '' } }
  fireEvent.dragStart(handle('Instruction Checks', 'Copy'), drag)
  fireEvent.dragOver(list('Command Checks').getByRole('listitem', { name: 'Typecheck' }))
  fireEvent.drop(list('Command Checks').getByRole('listitem', { name: 'Typecheck' }))
  expect(names('Command Checks')).toEqual(['Typecheck', 'Lint'])
  fireEvent.drop(list('Instruction Checks').getByRole('listitem', { name: 'Docs drift' }))
  fireEvent.dragEnd(handle('Instruction Checks', 'Copy'))
  expect(names('Instruction Checks')).toEqual(['Copy', 'Docs drift'])
  expect(onChange.mock.lastCall?.[0].instructionChecks.map((c) => c.was)).toEqual([3, 2])
})

test('Run now on an instruction Check runs it on a chosen Task and shows its report', async () => {
  const started = deferred<CheckTry>()
  const tryCheck = vi.fn(() => started.promise)
  const output = vi.fn(() => ({ text: 'Result: pass', log: '/logs/docs.log' }))
  bridge({
    listTasks: () => [task({ id: 't2', displayId: 'NB-2', stage: 'validate' })],
    checkTryTasks: () => [
      { id: 't1', displayId: 'NB-1', title: 'Sync notes' },
      { id: 't2', displayId: 'NB-2', title: 'Rename the parser' },
    ],
    tryCheck,
    checkTryOutput: output,
  })
  const u = user()
  const { rerender } = render(<Section />)
  await u.click(row('Instruction Checks', 'Docs drift').getByRole('button', { name: 'Run now…' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Run Docs drift on a Task' }))
  expect(dialog.getByText(/It doesn’t change the Task, open a failure case/)).toBeTruthy()
  const second = await dialog.findByRole('radio', { name: /NB-2/ })
  expect(await dialog.findByText('Validate')).toBeTruthy()
  expect((dialog.getByRole('radio', { name: /NB-1/ }) as HTMLInputElement).checked).toBe(true)
  await u.click(second)
  await u.click(dialog.getByRole('button', { name: 'Run' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(tryCheck).toHaveBeenCalledExactlyOnceWith('f1', {
    name: 'Docs drift',
    instruction: 'Fix stale docs.\nName each one.',
    taskId: 't2',
  })
  const running: CheckTry = {
    factoryId: 'f1',
    name: 'Docs drift',
    repo: 'widgets',
    state: 'running',
    startedAt: new Date().toISOString(),
    instruction: true,
    taskId: 't2',
    taskDisplayId: 'NB-2',
  }
  await act(async () => started.resolve(running))
  rerender(<Section tries={[running]} />)
  expect(row('Instruction Checks', 'Docs drift').getByText(/^Running on NB-2/)).toBeTruthy()
  expect(row('Instruction Checks', 'Docs drift').getByRole('button', { name: 'Stop' })).toBeTruthy()
  expect(
    (
      row('Instruction Checks', 'Copy').getByRole('button', {
        name: 'Run now…',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true)

  rerender(
    <Section
      tries={[{ ...running, state: 'failed', noReport: 'it ended without a result line' }]}
    />,
  )
  const docs = row('Instruction Checks', 'Docs drift')
  expect(docs.getByText(/No report on NB-2/)).toBeTruthy()
  await u.click(docs.getByRole('button', { name: 'Report' }))
  expect(output).toHaveBeenCalledWith('f1', 'Docs drift')
  const report = within(await screen.findByRole('dialog', { name: 'Docs drift report' }))
  expect(report.getByText('Result: pass')).toBeTruthy()
  await u.click(report.getByRole('button', { name: 'Close' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})
