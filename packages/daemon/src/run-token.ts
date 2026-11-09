import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

export interface RunTokens {
  issue(runId: string): string
  verify(token: string): string | undefined
}

export async function loadRunTokens(keyPath: string): Promise<RunTokens> {
  const key = await readOrCreateKey(keyPath)
  const sign = (runId: string) => createHmac('sha256', key).update(runId).digest('hex')
  return {
    issue: (runId) => `${runId}.${sign(runId)}`,
    verify(token) {
      const dot = token.lastIndexOf('.')
      if (dot <= 0) return undefined
      const runId = token.slice(0, dot)
      const given = Buffer.from(token.slice(dot + 1))
      const expected = Buffer.from(sign(runId))
      return given.length === expected.length && timingSafeEqual(given, expected)
        ? runId
        : undefined
    },
  }
}

async function readOrCreateKey(keyPath: string): Promise<Buffer> {
  try {
    await writeFile(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return readFile(keyPath)
}
