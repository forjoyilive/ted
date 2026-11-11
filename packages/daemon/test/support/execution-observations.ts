import { appendFile } from 'node:fs/promises'
import { redactSecrets } from '../../src/redact.ts'

export async function observe(invariant: string, observed: unknown): Promise<void> {
  const file = process.env.TED_VALIDATION_OBSERVATIONS
  if (file) await appendFile(file, `${redactSecrets(JSON.stringify({ invariant, observed }))}\n`)
}
