import { readFileSync } from 'node:fs'

export const writingGuidance = readFileSync(
  new URL('./workflow/defaults/writing.md', import.meta.url),
  'utf8',
).trim()
