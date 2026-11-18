import type { CheckResult, FailureCase, ValidationProgress } from '@ted/protocol'
import { validationExecution } from '@ted/protocol'
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
