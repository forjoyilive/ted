// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { Findings, OutputBlock } from '../src/renderer/components/EventLine.tsx'
import { noteParts } from '../src/renderer/note-parts.ts'
import { user } from './support/component.ts'

const tall = () => vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(600)

test('long findings start collapsed and expand in place', async () => {
  tall()
  render(<Findings text={'Line\n'.repeat(40)} />)
  const findings = screen.getByRole('region', { name: 'Blocking findings' })
  const more = within(findings).getByRole('button', { name: 'Show more' })
  expect(more.getAttribute('aria-expanded')).toBe('false')
  expect(findings.querySelector('[data-collapsed]')).not.toBeNull()

  await user().click(more)
  const less = within(findings).getByRole('button', { name: 'Show less' })
  expect(less.getAttribute('aria-expanded')).toBe('true')
  expect(findings.querySelector('[data-collapsed]')).toBeNull()

  await user().click(less)
  expect(within(findings).getByRole('button', { name: 'Show more' })).toBeTruthy()
})

test('a short block shows in full with no control', () => {
  render(<OutputBlock text="error: one line" />)
  const output = screen.getByRole('region', { name: 'Output' })
  expect(within(output).queryByRole('button')).toBeNull()
  expect(output.querySelector('pre')?.textContent).toBe('error: one line')
})

test('failure output keeps its line breaks in a monospace block', () => {
  render(<OutputBlock text={'PASS a.test.js\nFAIL b.test.js\n  ● it broke'} />)
  const output = screen.getByRole('region', { name: 'Output' })
  expect(output.querySelector('pre')?.textContent).toBe(
    'PASS a.test.js\nFAIL b.test.js\n  ● it broke',
  )
  expect(output.hasAttribute('data-chat-wide')).toBe(true)
})

test('long output shows its last 10 lines until expanded', async () => {
  const lines = Array.from({ length: 25 }, (_, n) => `line ${n + 1}`)
  render(<OutputBlock text={lines.join('\n')} />)
  const output = screen.getByRole('region', { name: 'Output' })
  expect(output.querySelector('pre')?.textContent).toBe(lines.slice(15).join('\n'))
  const show = within(output).getByRole('button', { name: /15 earlier lines hidden/ })
  expect(show.textContent).toContain('Show all 25 lines')
  expect(show.getAttribute('aria-expanded')).toBe('false')

  await user().click(show)
  expect(output.querySelector('pre')?.textContent).toBe(lines.join('\n'))
  await user().click(within(output).getByRole('button', { name: 'Show the last 10 lines only' }))
  expect(output.querySelector('pre')?.textContent).toBe(lines.slice(15).join('\n'))
})

test('a Ted note splits its fenced blocks from the prose', () => {
  expect(noteParts('Failure ecfe8a\n\nThe Task stays\nin Merge.')).toEqual({
    text: 'Failure ecfe8a The Task stays in Merge.',
    rest: [],
  })
  expect(
    noteParts(
      'Failure ecfe8a\n\nLast 200 lines of its output:\n\n```\nPASS a\n\nFAIL b\n```\n\nFull output: log.txt',
    ),
  ).toEqual({
    text: 'Failure ecfe8a Last 200 lines of its output:',
    rest: [
      { kind: 'block', line: 4, text: 'PASS a\n\nFAIL b' },
      { kind: 'text', line: 9, text: 'Full output: log.txt' },
    ],
  })
  expect(noteParts('Output:\n````\nholds ```\n````').rest).toEqual([
    { kind: 'block', line: 1, text: 'holds ```' },
  ])
  expect(noteParts('Output:\n```\nnever closed\n').rest).toEqual([
    { kind: 'block', line: 1, text: 'never closed' },
  ])
  expect(noteParts('Empty:\n```\n```').rest).toEqual([])
  expect(noteParts('```\nfirst\n```\nafter').text).toBe('')
})

test('each label stays beside its own block', () => {
  const body = [
    'Failure 1a2b3c',
    '1. The instruction check “Docs” failed.',
    'Its instruction, from the Factory:',
    '```',
    'Read the docs.',
    '```',
    'The agent’s report:',
    '```',
    'Docs are stale.',
    '```',
    'Full report: report.md',
  ].join('\n')
  expect(noteParts(body)).toEqual({
    text: 'Failure 1a2b3c 1. The instruction check “Docs” failed. Its instruction, from the Factory:',
    rest: [
      { kind: 'block', line: 3, text: 'Read the docs.' },
      { kind: 'text', line: 6, text: 'The agent’s report:' },
      { kind: 'block', line: 7, text: 'Docs are stale.' },
      { kind: 'text', line: 10, text: 'Full report: report.md' },
    ],
  })
})
