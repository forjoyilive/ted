import { readFileSync } from 'node:fs'

export const writingGuidance = readFileSync(
  new URL('./workflow/defaults/writing.md', import.meta.url),
  'utf8',
).trim()

export const disclosureGuidance = readFileSync(
  new URL('./workflow/defaults/disclosure.md', import.meta.url),
  'utf8',
).trim()

export function disclosure(on: boolean): string[] {
  return on ? [disclosureGuidance] : []
}
