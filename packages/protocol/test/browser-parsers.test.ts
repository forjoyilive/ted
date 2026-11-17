import { expect, test } from 'vitest'
import {
  browserActions,
  parseBrowserPollRequest,
  parseBrowserReplyRequest,
  parseBrowserRequest,
} from '../src/index.ts'
import { rejects, roundTrip } from './parser-cases.ts'

roundTrip(parseBrowserRequest, {
  action: 'fill',
  app: { name: 'Web', repo: 'widgets' },
  ref: 'revision:1',
  value: 'Hello',
})
roundTrip(parseBrowserPollRequest, { session: 'owner' })
roundTrip(parseBrowserReplyRequest, {
  session: 'owner',
  canceled: true,
  error: 'Canceled',
  result: { url: 'http://localhost:3000/', text: 'Ready' },
})

for (const action of browserActions) {
  test(`parseBrowserRequest preserves ${action}`, () => {
    const request = {
      action,
      ...(action === 'open' && { app: { name: 'Web' } }),
      ...(['click', 'fill'].includes(action) && { ref: 'revision:1' }),
      ...(['fill', 'press', 'navigate'].includes(action) && { value: '' }),
      ...(action === 'resize' && { value: '390x844' }),
      ...(action === 'color-scheme' && { value: 'dark' }),
      ...(action === 'size' && { value: 'mobile-landscape' }),
    }
    expect(parseBrowserRequest(request)).toEqual(request)
  })
}

rejects(parseBrowserRequest, null, 'body must be a JSON object')
rejects(parseBrowserRequest, { action: 'evaluate' }, 'Unknown browser action')
rejects(parseBrowserRequest, { action: 'open' }, 'Name the web App')
rejects(parseBrowserRequest, { action: 'click' }, 'Name an element reference from snapshot')
rejects(parseBrowserRequest, { action: 'fill', ref: 'one' }, 'Give a value')
rejects(parseBrowserRequest, { action: 'open', app: { name: 3 } }, 'app.name must be text')
rejects(parseBrowserRequest, { action: 'snapshot', ref: 'x'.repeat(101) }, 'ref is too long')
rejects(parseBrowserRequest, { action: 'navigate', value: 'x'.repeat(16_001) }, 'value is too long')
rejects(parseBrowserRequest, { action: 'resize' }, 'Give a value')
rejects(
  parseBrowserRequest,
  { action: 'resize', value: '200x844' },
  'Give a size like 390x844, 320–3840 wide and 240–2160 high',
)
rejects(
  parseBrowserRequest,
  { action: 'resize', value: 'wide' },
  'Give a size like 390x844, 320–3840 wide and 240–2160 high',
)
rejects(parseBrowserRequest, { action: 'color-scheme', value: 'sepia' }, 'Use light or dark')
rejects(parseBrowserRequest, { action: 'size' }, 'Give a value')
rejects(
  parseBrowserRequest,
  { action: 'size', value: 'watch' },
  'Give desktop, tablet, mobile, tablet-landscape, mobile-landscape or a width from 320 to 3840',
)
rejects(parseBrowserPollRequest, { session: 'x'.repeat(101) }, 'session is too long')
rejects(parseBrowserReplyRequest, { session: 'owner', result: [] }, 'result must be an object')
rejects(parseBrowserReplyRequest, { session: 'owner', error: 3 }, 'error must be text')
rejects(
  parseBrowserReplyRequest,
  { session: 'owner', result: { text: 'x'.repeat(64_001) } },
  'text is too long',
)

test('browser replies cannot inject an attachment or unrecognized fields', () => {
  expect(
    parseBrowserReplyRequest({
      session: 'owner',
      canceled: false,
      result: { text: 'Ready', attachment: { hash: 'unowned' } },
      unexpected: true,
    }),
  ).toEqual({ session: 'owner', result: { text: 'Ready' } })
})
