// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { Markdown } from '../src/renderer/components/Markdown.tsx'
import { bridge, required, user } from './support/component.ts'

test('renders nested Markdown and keeps fenced code literal and keyboard reachable', () => {
  const text = [
    '# Heading one',
    '## Heading two',
    '### Heading three',
    '',
    '**Strong** and *emphasis* with `inline()`.',
    '',
    '> A quote',
    '',
    '- Parent',
    '  1. Nested first',
    '  2. Nested second',
    '',
    '| Name | Value |',
    '| --- | ---: |',
    '| Alpha | **42** |',
    '',
    '```sh',
    '# literal heading',
    '  echo "**literal**"',
    '',
    'echo done',
    '```',
  ].join('\n')
  const { container } = render(<Markdown text={text} />)
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Heading one')
  expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Heading two')
  expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Heading three')
  expect(screen.getByText('Strong').tagName).toBe('STRONG')
  expect(screen.getByText('emphasis').tagName).toBe('EM')
  expect(screen.getByText('inline()').tagName).toBe('CODE')
  expect(container.querySelector('blockquote')?.textContent).toContain('A quote')
  expect(container.querySelector('ul > li > ol')?.children).toHaveLength(2)
  const table = screen.getByRole('region', { name: 'Markdown table' })
  expect(table.tabIndex).toBe(0)
  expect(within(table).getByRole('cell', { name: '42' }).querySelector('strong')).toBeTruthy()
  const code = screen.getByRole('region', { name: 'Code block' })
  expect(code.tabIndex).toBe(0)
  expect(code.querySelector('code')?.textContent).toBe(
    '# literal heading\n  echo "**literal**"\n\necho done\n',
  )
  expect(code.querySelector('strong, h1')).toBeNull()
})

test('does not activate HTML, load images or expose non-web links', () => {
  const { container } = render(
    <Markdown
      text={
        '<img src="https://tracker.test/pixel" onerror="alert(1)">\n\n![Screenshot](https://tracker.test/image.png)\n\n[script](javascript:alert%281%29) [file](file:///tmp/secret) [relative](./notes.md) [data](data:text/html,hello)'
      }
    />,
  )
  expect(container.querySelector('img, script, iframe, a')).toBeNull()
  expect(screen.getByText('Screenshot')).toBeTruthy()
  expect(container.textContent).toContain('<img src=')
  expect(container.textContent).toContain('script file relative data')
})

test('opens web links through the bridge and reports a failed browser launch', async () => {
  const api = bridge({ openMarkdownLink: () => Promise.reject(new Error('Browser unavailable')) })
  render(<Markdown text="[Guide](https://example.com/guide?q=one#two)" />)
  await user().click(screen.getByRole('link', { name: 'Guide' }))
  expect(api.request).toHaveBeenCalledExactlyOnceWith(
    'openMarkdownLink',
    'https://example.com/guide?q=one#two',
  )
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', ' Browser unavailable')
})

test('renders an unfinished streamed fence and updates it when the message completes', () => {
  const view = render(<Markdown text={'Working…\n\n```ts\nconst x = "**raw**"'} />)
  expect(screen.getByRole('region', { name: 'Code block' }).textContent).toContain('**raw**')
  view.rerender(<Markdown text={'Working…\n\n```ts\nconst x = "**raw**"\n```\n\n**Done**'} />)
  expect(screen.getByText('Done').tagName).toBe('STRONG')
  expect(required(view.container.querySelector('code')).textContent).toBe('const x = "**raw**"\n')
})
