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
  tall()
  render(<OutputBlock text={'PASS a.test.js\nFAIL b.test.js\n  ● it broke'} />)
  const output = screen.getByRole('region', { name: 'Output' })
  expect(output.querySelector('pre')?.textContent).toBe(
    'PASS a.test.js\nFAIL b.test.js\n  ● it broke',
  )
  expect(output.hasAttribute('data-chat-wide')).toBe(true)
  expect(within(output).getByRole('button', { name: 'Show more' })).toBeTruthy()
})

test('a Ted note splits its fenced blocks from the prose', () => {
  expect(noteParts('Failure ecfe8a\n\nThe Task stays\nin Merge.')).toEqual({
    text: 'Failure ecfe8a The Task stays in Merge.',
    blocks: [],
  })
  expect(
    noteParts(
      'Failure ecfe8a\n\nLast 200 lines of its output:\n\n```\nPASS a\n\nFAIL b\n```\n\nFull output: log.txt',
    ),
  ).toEqual({
    text: 'Failure ecfe8a Last 200 lines of its output: Full output: log.txt',
    blocks: [{ line: 4, text: 'PASS a\n\nFAIL b' }],
  })
  expect(noteParts('Output:\n````\nholds ```\n````').blocks).toEqual([
    { line: 1, text: 'holds ```' },
  ])
  expect(noteParts('Output:\n```\nnever closed\n').blocks).toEqual([
    { line: 1, text: 'never closed' },
  ])
  expect(noteParts('Empty:\n```\n```').blocks).toEqual([])
})
