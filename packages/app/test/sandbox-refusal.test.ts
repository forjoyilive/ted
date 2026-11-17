import { expect, test } from 'vitest'
import { sandboxRefusal } from '../scripts/sandbox-refusal.ts'

test('Ted Dev refuses to open only inside Ted’s sandbox on macOS without the Electron exception', () => {
  expect(sandboxRefusal({})).toBeUndefined()
  expect(sandboxRefusal({ TED_SANDBOX: '0' })).toBeUndefined()
  const inside = sandboxRefusal({ TED_SANDBOX: '1' })
  if (process.platform === 'darwin') expect(inside).toMatch(/can’t open inside Ted’s sandbox/)
  else expect(inside).toBeUndefined()
  expect(sandboxRefusal({ TED_SANDBOX: '1', TED_SANDBOX_ELECTRON: '1' })).toBeUndefined()
})
