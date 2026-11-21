import { expect, test } from 'vitest'
import { sandboxRefusal } from '../scripts/sandbox-refusal.ts'

test('Ted Dev refuses to open in macOS sandboxes that block app registration', () => {
  expect(sandboxRefusal({})).toBeUndefined()
  expect(sandboxRefusal({ TED_SANDBOX: '0' })).toBeUndefined()
  const inside = sandboxRefusal({ TED_SANDBOX: '1' })
  if (process.platform === 'darwin') expect(inside).toMatch(/can’t open inside Ted’s sandbox/)
  else expect(inside).toBeUndefined()
  expect(sandboxRefusal({ TED_SANDBOX: '1', TED_SANDBOX_ELECTRON: '1' })).toBeUndefined()
  const codex = sandboxRefusal({ CODEX_SANDBOX: 'seatbelt' })
  if (process.platform === 'darwin') expect(codex).toMatch(/can’t open inside Codex’s sandbox/)
  else expect(codex).toBeUndefined()
  expect(
    sandboxRefusal({ CODEX_SANDBOX: 'seatbelt', TED_SANDBOX: '1', TED_SANDBOX_ELECTRON: '1' }),
  ).toBe(codex)
})
