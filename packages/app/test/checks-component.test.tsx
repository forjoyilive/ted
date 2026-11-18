// @vitest-environment jsdom
import type { CheckRun } from '@ted/protocol'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
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
    'Waiting to run checks',
  ])
  expect(checkRunHeadline({ ...run, checks, trigger: 'agent', waiting: true })).toEqual([
    'run',
    'Validate is waiting to run checks',
  ])
  expect(checkRunHeadline({ ...run, checks })).toEqual(['run', 'Running checks'])
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

const lineText = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join('\n')

function fakeScrolling() {
  const scrolled = new WeakMap<Element, number>()
  const lineHeight = 20
  const shownHeight = 100
  const height = (element: Element) => (element.textContent ?? '').split('\n').length * lineHeight
  Object.defineProperties(HTMLPreElement.prototype, {
    clientHeight: { configurable: true, get: () => shownHeight },
    scrollHeight: {
      configurable: true,
      get(this: HTMLPreElement) {
        return height(this)
      },
    },
    scrollTop: {
      configurable: true,
      get(this: HTMLPreElement) {
        return scrolled.get(this) ?? 0
      },
      set(this: HTMLPreElement, value: number) {
        scrolled.set(this, Math.max(0, Math.min(value, height(this) - shownHeight)))
      },
    },
  })
  return () => {
    for (const name of ['clientHeight', 'scrollHeight', 'scrollTop']) {
      Reflect.deleteProperty(HTMLPreElement.prototype, name)
    }
  }
}

function shownOutput(container: HTMLElement) {
  const pre = container.querySelector('pre')
  if (!pre) throw new Error('No output shown')
  return pre
}

test('Check output follows new lines only while scrolled to the bottom', async () => {
  const restore = fakeScrolling()
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  try {
    let lines = 10
    bridge({
      listFailures: () => [],
      checkOutput: () => ({ text: lineText('line', lines), log: '/test/check.log' }),
    })
    const running: CheckRun = {
      ...run,
      checks: run.checks.map((c, i) => (i === 1 ? { ...c, state: 'running' as const } : c)),
    }
    const { container } = render(
      <CheckOutputDialog checkRun={running} position={1} onClose={vi.fn()} />,
    )
    const output = () => shownOutput(container)
    const grow = async (count: number) => {
      lines = count
      act(() => void vi.advanceTimersByTime(1000))
      await expect.poll(() => output().textContent).toContain(`line ${count}`)
    }

    await expect.poll(() => output().textContent).toContain('line 10')
    expect(output().scrollTop).toBe(100)

    await grow(20)
    expect(output().scrollTop).toBe(300)

    output().scrollTop = 50
    fireEvent.scroll(output())
    await grow(30)
    expect(output().scrollTop).toBe(50)

    fireEvent.click(screen.getByRole('tab', { name: 'Tests' }))
    await grow(35)
    expect(output().scrollTop).toBe(50)

    output().scrollTop = 590
    fireEvent.scroll(output())
    await grow(40)
    expect(output().scrollTop).toBe(700)
  } finally {
    vi.useRealTimers()
    restore()
  }
})

test('a finished Check opens at the bottom and a tab switch starts at the bottom', async () => {
  const restore = fakeScrolling()
  try {
    bridge({
      listFailures: () => [],
      checkOutput: (_id, position) => ({
        text: position === 1 ? lineText('line', 30) : lineText('typed', 15),
        log: '/test/check.log',
      }),
    })
    const { container } = render(
      <CheckOutputDialog checkRun={run} position={1} onClose={vi.fn()} />,
    )
    const output = () => shownOutput(container)

    await expect.poll(() => output().textContent).toContain('line 30')
    expect(output().scrollTop).toBe(500)

    output().scrollTop = 50
    fireEvent.scroll(output())
    fireEvent.click(screen.getByRole('tab', { name: 'Typecheck' }))
    await expect.poll(() => output().textContent).toContain('typed 15')
    expect(output().scrollTop).toBe(200)
  } finally {
    restore()
  }
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

test('instruction Checks show their kind, duration, report, not-rerun note and missing report', async () => {
  const open = vi.fn()
  render(
    <ChecksRow
      checks={[
        {
          name: 'Docs drift',
          instruction: 'Fix stale docs.',
          fix: true,
          timeout: '20m',
          state: 'passed',
          durationMs: 182_000,
        },
        {
          name: 'Copy',
          instruction: 'Check the UI text.',
          timeout: '20m',
          state: 'passed',
          notRerun: true,
        },
        {
          name: 'Names',
          instruction: 'Check names.',
          timeout: '20m',
          state: 'failed',
          durationMs: 4_000,
          noReport: 'it ended without a result line',
        },
      ]}
      onOpen={open}
    />,
  )
  const items = screen.getAllByRole('listitem').map((item) => item.textContent)
  expect(items.slice(0, 3)).toEqual([
    '✓Docs drift · instruction · may fix · 3m 02s · Report',
    '✓Copy · instruction · not rerun: the Task’s own changes are the same as when it passed',
    '✗Names · instruction · no report: it ended without a result line · 4s · Report',
  ])
  const reports = screen.getAllByRole('button', { name: 'Report' })
  expect(reports).toHaveLength(2)
  await user().click(reports[1] as HTMLElement)
  expect(open).toHaveBeenCalledWith(2)
})
