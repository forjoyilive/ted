import type { CheckResult, FailureCase, ValidationProgress } from '@ted/protocol'
import { validationExecution } from '@ted/protocol'
import { describeResult } from './checks.ts'

export function failureCaseFindings(value: FailureCase): string {
  return [
    `Failure ${value.id}`,
    value.evidence,
    ...value.additions.map((a) => a.evidence),
    `Assessment: ${value.assessments.at(-1)?.assessment ?? 'uncertain'}`,
    `Recommendation: ${value.assessments.at(-1)?.recommendation ?? ''}`,
  ].join('\n\n')
}

export function sameCheckPlan(checks: readonly CheckResult[]): string {
  return JSON.stringify(
    checks.map(({ name, repo, command, timeout, builtIn }) => ({
      name,
      repo,
      command,
      timeout,
      builtIn,
    })),
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
          f.source.kind === 'factory-check' &&
          f.source.checkRunId === execution?.runId &&
          f.source.position === position - execution.start &&
          f.originalCheck?.name === check.name &&
          f.originalCheck?.repo === check.repo &&
          f.originalCheck?.command === check.command &&
          f.resolutions.at(-1)?.resolution === 'accepted' &&
          !f.verifications?.length &&
          !f.invalidations.some((i) => i.requestId === f.resolutions.at(-1)?.requestId),
      )
      return `${describeResult(check)}${failure ? ` · failed, accepted by you (failure ${failure.id})` : ''}`
    })
    .join('\n')
}
