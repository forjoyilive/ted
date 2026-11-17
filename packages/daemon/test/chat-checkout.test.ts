import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { discard } from '../src/chats/checkout.ts'

let scratch: string | undefined
afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true })
  scratch = undefined
})

test('discarding a checkout never follows a link out of its parent folder', async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-chat-checkout-'))
  const base = path.join(scratch, 'chat-code')
  const outside = path.join(scratch, 'outside')
  await mkdir(base)
  await mkdir(path.join(outside, 'repo'), { recursive: true })
  await writeFile(path.join(outside, 'repo', 'keep.txt'), 'keep')
  const linked = path.join(base, 'chat')
  await symlink(outside, linked)
  await discard([{ clone: outside, worktree: path.join(linked, 'repo') }], linked)
  expect(existsSync(path.join(outside, 'repo', 'keep.txt'))).toBe(true)

  const plain = path.join(base, 'plain')
  await mkdir(path.join(plain, 'repo'), { recursive: true })
  await discard([], plain)
  expect(existsSync(plain)).toBe(false)
})
