import type { CheckResult, FailureCase, ValidationProgress } from '@ted/protocol'
import { checkLabel, validationExecution } from '@ted/protocol'
import { shortReference } from '@ted/protocol/reference'
import { describeResult } from './checks.ts'

export function failureCaseReference(value: FailureCase, full = false): string {
  const decision = value.resolutions.at(-1)
  return `Failure ${full ? value.id : shortReference(value.id)}${decision?.resolution === 'fix' ? ` · Fix request ${decision.requestId}` : ''}`
}

export function failureCaseFindings(value: FailureCase): string {
  return [
    failureCaseReference(value),
    ...(value.source.kind === 'finding' ? [value.source.finding] : []),
    value.evidence,
    ...value.additions.map((a) => a.evidence),
    `Assessment: ${value.assessments.at(-1)?.assessment ?? 'uncertain'}`,
    `Recommendation: ${value.assessments.at(-1)?.recommendation ?? ''}`,
  ].join('\n\n')
}

function failureSubject(value: FailureCase): string {
  const { source } = value
  if (source.kind === 'finding') {
    const line = source.finding.split('\n')[0] ?? ''
    return line.length > 120 ? `${line.slice(0, 119)}…` : line
  }
  if (source.kind === 'github-ci') return `CI on ${source.repo} #${source.number}`
  return `the ${value.originalCheck ? checkLabel(value.originalCheck) : 'Factory'} check`
}

function closedAs(value: FailureCase): string | undefined {
  if (value.verifications?.length) return 'passed on a later run'
  const resolution = value.resolutions.at(-1)?.resolution
  if (resolution === 'fixed') return 'fixed'
  if (resolution === 'no-longer-applicable') return 'no longer applies'
  return undefined
}

export function briefFailureHistory(cases: readonly FailureCase[]): string {
  const closed: string[] = []
  const open: string[] = []
  for (const value of cases) {
    const how = closedAs(value)
    if (how !== undefined) {
      closed.push(`- ${failureCaseReference(value)} · ${failureSubject(value)} · ${how}`)
      continue
    }
    const decision = value.resolutions.at(-1)
    const accepted =
      decision?.resolution === 'accepted' &&
      !value.invalidations.some((i) => i.requestId === decision.requestId)
    open.push(
      `${failureCaseFindings(value)}\n\nDecision: ${accepted ? 'failed, accepted by you' : (decision?.resolution ?? 'unresolved')}${decision?.reason ? ` · ${decision.reason}` : ''}`,
    )
  }
  return [...(closed.length ? [closed.join('\n')] : []), ...open].join('\n\n')
}

export function sameCheckPlan(checks: readonly CheckResult[]): string {
  return JSON.stringify(
    checks.map(
      ({ name, repo, command, timeout, builtIn, instruction, fix, agent, model, effort }) =>
        instruction === undefined
          ? { name, repo, command, timeout, builtIn }
          : { name, instruction, fix, agent, model, effort, timeout },
    ),
  )
}

export function validationReport(
  progress: ValidationProgress,
  failures: readonly FailureCase[],
): string {
  return progress.checks
    .map((check, position) => {
      const execution = validationExecution(progress, position)
      const failure = failures.find(
        (f) =>
          (f.source.kind === 'factory-check' || f.source.kind === 'post-rebase-check') &&
          f.source.checkRunId === execution?.runId &&
          f.source.position === position - execution.start &&
          f.resolutions.at(-1)?.resolution === 'accepted' &&
          !f.verifications?.length &&
          !f.invalidations.some((i) => i.requestId === f.resolutions.at(-1)?.requestId),
      )
      return `${describeResult(check)}${failure ? ` · failed, accepted by you (failure ${shortReference(failure.id)})` : ''}`
    })
    .join('\n')
}
