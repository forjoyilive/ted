import { createHash } from 'node:crypto'
import type { FailureCase, FailureSource } from '@ted/protocol'
import { ciFailureKey } from './failure-cases.ts'
import { clean, trustedCheck } from './github-activity.ts'
import { type RemoteCheck, type RemotePullRequest, relevantChecks } from './merge.ts'

export type CiSource = Extract<FailureSource, { kind: 'github-ci' }>
export type CiCase = FailureCase & { source: CiSource }

export interface CiPull {
  repo: string
  number: number
  pr: RemotePullRequest
  record: boolean
  host?: string
}

export type CiStep =
  | { kind: 'record'; source: CiSource; check: RemoteCheck; pull: CiPull; replaces?: string }
  | { kind: 'close'; id: string; evidence: string }
  | { kind: 'send-back'; id: string }

export function checkKeyOf(check: Pick<RemoteCheck, 'kind' | 'app' | 'name'>): string {
  return createHash('sha256')
    .update(JSON.stringify([check.kind ?? '', check.app ?? '', check.name]))
    .digest('hex')
}

export function ciSource(
  pull: Pick<CiPull, 'repo' | 'number' | 'pr'>,
  check: RemoteCheck,
): CiSource {
  const name = trustedCheck(pull.pr, check) ? clean(check.name, 200) : ''
  return {
    kind: 'github-ci',
    repo: pull.repo,
    number: pull.number,
    head: pull.pr.headRefOid,
    attempt: check.identity ?? '',
    checkKey: checkKeyOf(check),
    required: check.required,
    ...(name && { check: name }),
  }
}

export function mergeCiCase(value: FailureCase): value is CiCase {
  return value.validation === true && value.source.kind === 'github-ci'
}

export function openCiCase(value: FailureCase): value is CiCase {
  return (
    mergeCiCase(value) &&
    !value.verifications?.length &&
    !['fixed', 'no-longer-applicable'].includes(value.resolutions.at(-1)?.resolution ?? '')
  )
}

export function acceptedCiCase(value: FailureCase): value is CiCase {
  const decision = value.resolutions.at(-1)
  return (
    openCiCase(value) &&
    decision?.resolution === 'accepted' &&
    !value.invalidations.some((i) => i.requestId === decision.requestId)
  )
}

export function awaitsRerun(value: FailureCase): boolean {
  const decision = value.resolutions.at(-1)
  return (
    openCiCase(value) &&
    (decision?.resolution === 'retry' ||
      (decision?.resolution === 'repair' &&
        value.repairProgress?.some((p) => p.requestId === decision.requestId) === true))
  )
}

export function unscoped(pr: RemotePullRequest): boolean {
  return pr.checksComplete !== true || pr.checks.some((c) => !c.identity)
}

const samePull = (source: CiSource, pull: Pick<CiPull, 'repo' | 'number'>) =>
  source.repo.toLowerCase() === pull.repo.toLowerCase() && source.number === pull.number

function wantsSendBack(value: CiCase): boolean {
  const decision = value.resolutions.at(-1)
  const assessment = value.assessments.at(-1)
  if (decision?.resolution === 'fix') return true
  return (
    assessment?.assessment === 'regression' &&
    assessment.evidenceCount === value.additions.length &&
    assessment.at > (decision?.at ?? '')
  )
}

export function ciFailureSteps(input: {
  merging: boolean
  cases: readonly FailureCase[]
  pulls: readonly CiPull[]
}): CiStep[] {
  const steps: CiStep[] = []
  const open = input.cases.filter(openCiCase)
  const closing = new Set<string>()
  for (const value of open) {
    if (!input.merging) {
      closing.add(value.id)
      steps.push({
        kind: 'close',
        id: value.id,
        evidence:
          'Closed without a pass: the Task left Merge. TED looks at CI afresh when the Task comes back to Merge.',
      })
      continue
    }
    const pull = input.pulls.find((p) => samePull(value.source, p))
    if (!pull) continue
    if (pull.pr.headRefOid !== value.source.head) {
      closing.add(value.id)
      steps.push({
        kind: 'close',
        id: value.id,
        evidence: `Closed without a pass: ${pull.repo}#${pull.number} moved to commit ${pull.pr.headRefOid}. TED looks at CI on the new commit afresh.`,
      })
      continue
    }
    const attempts = pull.pr.checks.filter((c) => checkKeyOf(c) === value.source.checkKey)
    if (attempts.some((c) => c.identity === value.source.attempt && c.state === 'failed')) {
      if (wantsSendBack(value)) steps.push({ kind: 'send-back', id: value.id })
      continue
    }
    if (attempts.length > 0 && attempts.every((c) => c.state === 'passed')) {
      closing.add(value.id)
      steps.push({
        kind: 'close',
        id: value.id,
        evidence: `Passed on a later attempt on GitHub at commit ${pull.pr.headRefOid}.`,
      })
    }
  }
  for (const pull of input.pulls) {
    if (!input.merging || !pull.record || unscoped(pull.pr)) continue
    for (const check of relevantChecks(pull.pr)) {
      if (check.state !== 'failed') continue
      const source = ciSource(pull, check)
      const key = ciFailureKey(source)
      if (open.some((value) => ciFailureKey(value.source) === key)) continue
      const replaces = open.find(
        (value) =>
          !closing.has(value.id) &&
          samePull(value.source, pull) &&
          value.source.head === source.head &&
          value.source.checkKey === source.checkKey,
      )
      steps.push({
        kind: 'record',
        source,
        check,
        pull,
        ...(replaces && { replaces: replaces.id }),
      })
    }
  }
  return steps
}
