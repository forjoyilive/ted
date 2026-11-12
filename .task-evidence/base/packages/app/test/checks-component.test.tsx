// @vitest-environment jsdom
import type { CheckRun } from '@ted/protocol'
import { render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { CheckOutputDialog } from '../src/renderer/components/CheckOutputDialog.tsx'
import { ChecksRow } from '../src/renderer/components/ChecksRow.tsx'
import { checkRunHeadline } from '../src/renderer/views/CheckEvents.tsx'
import { appState } from './support/app.tsx'
import { bridge, user } from './support/component.ts'
import { createdAt, task } from './support/fixtures.ts'

const run: CheckRun = {
  id: 'checks-1',
  taskId: 'NB-1',
  trigger: 'validate',
  stage: 'validate',
  startedAt: createdAt,
  checks: [
    { name: 'Typecheck', command: 'echo typed', timeout: '1m', state: 'passed' },
    { name: 'Tests', command: 'npm test', timeout: '1m', state: 'failed', exitCode: 1 },
    { name: 'Lint', command: 'npm run lint', timeout: '1m', state: 'not-run' },
  ],
}

test('Checks distinguish pass, failure, not-run and Review/Visual judgments', async () => {
  const open = vi.fn()
  render(
    <ChecksRow
      checks={run.checks}
      judgments={[
        { name: 'Review', passed: true, notes: 2 },
        { name: 'Visual', passed: true },
      ]}
      onOpen={open}
    />,
  )
  expect(screen.getByRole('button', { name: '✓Typecheck' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '✗Tests' })).toBeTruthy()
  expect(screen.getByText('· not run')).toBeTruthy()
  expect(screen.getByText('· 2 notes')).toBeTruthy()
  expect(screen.getByText('Visual')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Lint/ })).toBeNull()
  await user().click(screen.getByRole('button', { name: '✗Tests' }))
  expect(open).toHaveBeenCalledWith(1)
})

test('a Check run waiting for a place says so instead of Running Checks', () => {
  const checks = run.checks.map((c) => ({ ...c, state: 'waiting' as const }))
  expect(checkRunHeadline({ ...run, checks, waiting: true })).toEqual([
    'run',
    'Waiting to run Checks',
  ])
  expect(checkRunHeadline({ ...run, checks, trigger: 'agent', waiting: true })).toEqual([
    'run',
    'Validate is waiting to run Checks',
  ])
  expect(checkRunHeadline({ ...run, checks })).toEqual(['run', 'Running Checks'])
})

test('Check output opens the failed output and tabs switch to another Check', async () => {
  const close = vi.fn()
  const api = bridge({
    listFailures: () => [],
    checkOutput: (_id, position) => ({
      text: position === 1 ? 'SearchPanel hangs' : 'typed',
      log: '/test/check.log',
    }),
  })
  render(<CheckOutputDialog checkRun={run} position={1} onClose={close} />)
  await screen.findByText('SearchPanel hangs')
  expect(screen.getByRole('dialog', { name: 'Tests output' })).toBeTruthy()
  await user().click(screen.getByRole('tab', { name: 'Typecheck' }))
  await screen.findByText('typed')
  expect(api.request).toHaveBeenCalledWith('checkOutput', 'checks-1', 0)
  expect(screen.queryByRole('tab', { name: 'Lint' })).toBeNull()
  await user().click(screen.getByRole('button', { name: 'Close' }))
  expect(close).toHaveBeenCalledOnce()
})

test('blocking findings keep their content in a labelled region', async () => {
  const { Findings } = await import('../src/renderer/components/EventLine.tsx')
  render(<Findings text="The Check “Tests” failed: SearchPanel hangs" />)
  expect(screen.getByRole('region', { name: 'Blocking findings' }).textContent).toContain(
    'The Check “Tests” failed: SearchPanel hangs',
  )
})

test('a failed Validate thread event opens its associated Check output and switches tabs', async () => {
  const a = appState()
  a.state.tasks = [task()]
  a.handle('listThreadEvents', () => [
    {
      id: 'e1',
      taskId: 'NB-1',
      at: createdAt,
      tone: 'failure',
      text: 'Validate sent this Task back to Work',
      checkRunId: 'checks-1',
      validate: 'sent-back',
      findings: 'SearchPanel hangs',
    },
  ])
  a.handle('listCheckRuns', () => [run])
  a.handle('listFailures', () => [
    {
      id: 'failure-1',
      taskId: 'NB-1',
      validation: true,
      source: { kind: 'factory-check', checkRunId: run.id, position: 1 },
      evidence: 'The stored Tests execution failed.',
      recordedBy: 'lead-1',
      provenance: 'stored-check',
      createdAt,
      assessments: [],
      additions: [],
      decisions: [],
      resolutions: [{ requestId: 'decision-1', resolution: 'accepted', at: createdAt }],
      invalidations: [],
    },
  ])
  a.handle('checkOutput', (id, position) => {
    expect(id).toBe('checks-1')
    return { text: position === 1 ? 'SearchPanel hangs' : 'typed', log: '/test/check.log' }
  })
  a.mount()
  await user().click(await screen.findByRole('button', { name: 'All Tasks' }))
  await user().click(within(screen.getByRole('main')).getByText('Sync notes'))
  const thread = await screen.findByRole('region', { name: 'Task thread' })
  await user().click(
    await within(thread).findByRole('button', { name: /✗Tests.*failed, accepted by you/ }),
  )
  const output = await screen.findByRole('dialog', { name: 'Tests output' })
  await within(output).findByText('SearchPanel hangs')
  expect(a.request).toHaveBeenCalledWith('checkOutput', 'checks-1', 1)
  await user().click(within(output).getByRole('tab', { name: 'Typecheck' }))
  await within(output).findByText('typed')
  expect(a.request).toHaveBeenCalledWith('checkOutput', 'checks-1', 0)
  await user().click(within(output).getByRole('button', { name: 'Close' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('accepted failures keep their failing glyph and explicit label', () => {
  render(<ChecksRow checks={run.checks} accepted={[1]} onOpen={vi.fn()} />)
  expect(screen.getByRole('button', { name: /✗Tests.*failed, accepted by you/ })).toBeTruthy()
  expect(screen.getByText('· not run')).toBeTruthy()
})
