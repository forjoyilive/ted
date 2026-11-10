// @vitest-environment jsdom
import type { CheckRun } from '@ted/protocol'
import { render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { CheckOutputDialog } from '../src/renderer/components/CheckOutputDialog.tsx'
import { ChecksRow } from '../src/renderer/components/ChecksRow.tsx'
import { bridge, user } from './support/component.ts'
import { createdAt } from './support/fixtures.ts'

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

test('Check output opens the failed output and tabs switch to another Check', async () => {
  const close = vi.fn()
  const api = bridge({
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
