import { handsOff } from '@ted/protocol/stage'
import { redactSecrets } from '../redact.ts'
import { oneLine } from './review-rounds.ts'

export interface AdoptedBase {
  repo: string
  base: string
  from: string
  to: string
}

export type BaseStep = 'current' | 'move' | 'own-commits' | 'clone-behind'

export function firstWorkEntry(to: string, entries: readonly { stage: string }[]): boolean {
  return handsOff(to) && !entries.some((entry) => handsOff(entry.stage))
}

export function baseStep(found: {
  head: string
  tip: string
  headInTip: boolean
  tipInClone: boolean
}): BaseStep {
  if (found.head === found.tip) return 'current'
  if (!found.headInTip) return 'own-commits'
  return found.tipInClone ? 'move' : 'clone-behind'
}

const named = (text: string) => redactSecrets(oneLine(text)).slice(0, 200)

export function latestBaseNote(moved: readonly AdoptedBase[], multiRepo: boolean): string {
  const [first] = moved
  if (!first) return ''
  const what = multiRepo
    ? moved.map((m) => `the ${named(m.repo)} branch to the latest ${named(m.base)}`).join(' and ')
    : `this Task’s branch to the latest ${named(first.base)}`
  const had = moved.length === 1 ? 'It had' : 'They had'
  return `TED moved ${what} before Work started. ${had} no commits of this Task yet. Files may differ from what was read in the earlier Stages, so read a file again before you rely on what it said. If the dependencies changed, run the repo’s dependency install again.`
}
