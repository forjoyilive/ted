import { handsOff, validates } from '@ted/protocol/stage'
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
  return `Ted moved ${what} before Work started. ${had} no commits of this Task yet. Files may differ from what was read in the earlier Stages, so read a file again before you rely on what it said. If the dependencies changed, run the repo’s dependency install again.`
}

export type BaseMerge =
  | { repo: string; base: string; outcome: 'merged'; from: string; to: string; commit: string }
  | { repo: string; base: string; outcome: 'conflict' | 'uncommitted' | 'failed' }

export function returnedForCheck(
  from: string,
  to: string,
  latest: { to: string; cause?: string; at: string } | undefined,
  visitStart: string,
): boolean {
  return (
    validates(from) &&
    handsOff(to) &&
    latest !== undefined &&
    latest.cause === 'check' &&
    latest.to === to &&
    latest.at >= visitStart
  )
}

const before = 'before you call the failed check unrelated or file a repair Task'

function mergeSentence(result: BaseMerge, multiRepo: boolean): string {
  const branch = multiRepo ? `the ${named(result.repo)} branch` : 'this Task’s branch'
  const base = named(result.base)
  if (result.outcome === 'merged')
    return `Ted merged the latest ${base} into ${branch} on the way back to Work. If the failed check came from outside this Task, it may already be fixed there, so read the failure again against the merged code ${before}. If the dependencies changed, run the repo’s dependency install again.`
  if (result.outcome === 'conflict')
    return `Ted couldn’t merge the latest ${base} into ${branch}: they conflict. Merge ${base} yourself and resolve the conflicts ${before}.`
  if (result.outcome === 'uncommitted')
    return `Ted couldn’t merge the latest ${base} into ${branch} because the worktree has uncommitted changes. Commit your own work, then merge ${base} ${before}.`
  return `Ted couldn’t merge the latest ${base} into ${branch}. Merge ${base} yourself ${before}.`
}

export function mergedBaseNote(results: readonly BaseMerge[], multiRepo: boolean): string {
  return results.map((result) => mergeSentence(result, multiRepo)).join(' ')
}
