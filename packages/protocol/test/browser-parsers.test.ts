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
