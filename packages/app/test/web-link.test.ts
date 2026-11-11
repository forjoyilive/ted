import { expect, test, vi } from 'vitest'
import { openMarkdownLink, webLink } from '../src/web-link.ts'

test.each([
  'https://example.com/path?q=1#section',
  'http://localhost:3000/',
  'HTTPS://EXAMPLE.COM',
])('opens validated web URLs: %s', async (value) => {
  const open = vi.fn(async () => {})
  await openMarkdownLink(value, open)
  expect(open).toHaveBeenCalledExactlyOnceWith(new URL(value).href)
})

test.each([
  'javascript:alert(1)',
  'file:///tmp/file',
  'data:text/html,hello',
  'mailto:user@example.com',
  './local',
  '//example.com',
  'https:example.com',
  'https:///example.com',
  'https://',
  'https://user:secret@example.com',
  'https://example.com\\@evil.test',
  'https://exa\nmple.com',
  'https://example.com/\u0000',
  'https://example.com/\u007f',
  ' https://example.com',
  {},
  null,
])('rejects invalid bridge input before opening a browser: %j', async (value) => {
  const open = vi.fn(async () => {})
  expect(webLink(value)).toBeUndefined()
  await expect(openMarkdownLink(value, open)).rejects.toThrow('Only HTTP and HTTPS')
  expect(open).not.toHaveBeenCalled()
})
