import { readFileSync } from 'node:fs'
import type { MachineSettings } from '@ted/protocol'

function defaultText(name: string): string {
  return readFileSync(new URL(`./workflow/defaults/${name}`, import.meta.url), 'utf8').trim()
}

const writing = defaultText('writing.md')
const skills = defaultText('skills.md')
const disclosure = defaultText('disclosure.md')

export const baseGuidance: readonly string[] = [writing, skills]

export const guidanceTexts: readonly string[] = [...baseGuidance, disclosure]

export function promptGuidance(settings: Pick<MachineSettings, 'aiDisclosure'>): string[] {
  return [...baseGuidance, ...(settings.aiDisclosure ? [disclosure] : [])]
}
