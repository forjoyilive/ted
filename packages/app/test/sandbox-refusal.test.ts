import { expect, test } from 'vitest'
import { sandboxRefusal } from '../scripts/sandbox-refusal.ts'

test('TED Dev refuses to open only inside TED’s sandbox on macOS', () => {
  expect(sandboxRefusal({})).toBeUndefined()
  expect(sandboxRefusal({ TED_SANDBOX: '0' })).toBeUndefined()
  const inside = sandboxRefusal({ TED_SANDBOX: '1' })
  if (process.platform === 'darwin') expect(inside).toMatch(/can’t open inside TED’s sandbox/)
  else expect(inside).toBeUndefined()
})
