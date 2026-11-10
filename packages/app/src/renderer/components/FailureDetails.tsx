import type { FailureCase } from '@ted/protocol'
import { validationExecution } from '@ted/protocol'
import { useState } from 'react'
import { useCheckRuns, useFailures, useValidationObligations } from '../data.ts'
import { CheckOutputDialog } from './CheckOutputDialog.tsx'
import { ChecksRow } from './ChecksRow.tsx'
import styles from './RequestCard.module.css'

export function acceptedFailure(failure: FailureCase): boolean {
  const decision = failure.resolutions.at(-1)
  return (
    decision?.resolution === 'accepted' &&
    !failure.verifications?.length &&
    !failure.invalidations.some((i) => i.requestId === decision.requestId)
  )
}

export function acceptedPositions(failures: readonly FailureCase[], runId: string): number[] {
  return failures.flatMap((f) =>
    acceptedFailure(f) &&
    (f.source.kind === 'factory-check' || f.source.kind === 'post-rebase-check') &&
    f.source.checkRunId === runId
      ? [f.source.position]
      : [],
  )
}

export function FailureDetails({ failure }: { failure: FailureCase }) {
  const assessment = failure.assessments.at(-1)
  const decision = failure.resolutions.at(-1)
  const disposition = acceptedFailure(failure)
    ? 'failed, accepted by you'
    : failure.invalidations.length && decision?.resolution === 'accepted'
      ? 'acceptance invalidated'
      : failure.verifications?.at(-1)?.replacedBy
        ? 'retry failed again; see the new failure'
        : failure.verifications?.length
          ? 'verified by a later execution'
          : (decision?.resolution ?? 'unresolved')
  return (
    <section className={styles.content} aria-label="Failure assessment and decision">
      <p className={styles.sectionBody}>
        Failure {failure.id} · {disposition}
      </p>
      {failure.source.kind === 'finding' && (
        <>
          <h3 className={styles.sectionHeading}>Finding</h3>
          <p className={styles.sectionBody}>{failure.source.finding}</p>
        </>
      )}
      <h3 className={styles.sectionHeading}>Assessment</h3>
      <p className={styles.sectionBody}>{assessment?.assessment ?? 'Investigation in progress'}</p>
      <h3 className={styles.sectionHeading}>Evidence</h3>
      <p className={styles.sectionBody}>{failure.evidence}</p>
      {failure.additions.map((addition) => (
        <p
          key={`${addition.runId}:${addition.at}:${addition.evidence}`}
          className={styles.sectionBody}
        >
          {addition.evidence}
        </p>
      ))}
      {assessment && (
        <>
          <h3 className={styles.sectionHeading}>Recommendation</h3>
          <p className={styles.sectionBody}>{assessment.recommendation}</p>
        </>
      )}
      <p className={styles.sectionBody}>Tested context: {failure.contextId ?? 'unknown'}</p>
      {decision && (
        <p className={styles.sectionBody}>
          Human decision: {decision.resolution} · {decision.reason}
        </p>
      )}
      <p className={styles.caption}>
        Acceptance applies only to this failure. Remaining Checks, validation and merge approval are
        still required.
      </p>
    </section>
  )
}

export function FailureRequestDetails({
  taskId,
  requestId,
  fallback,
}: {
  taskId: string
  requestId: string
  fallback: string
}) {
  const failures = useFailures(taskId)
  const failure = failures.find((f) => f.decisions.some((d) => d.commentId === requestId))
  return failure ? (
    <FailureDetails failure={failure} />
  ) : (
    <p className={styles.summary}>{fallback}</p>
  )
}

export function ValidationSummary({ taskId }: { taskId: string }) {
  const failures = useFailures(taskId)
  const obligations = useValidationObligations(taskId)
  const runs = useCheckRuns(taskId)
  const [output, setOutput] = useState<{ runId: string; position: number }>()
  const progress = obligations?.progress
  const run = runs.find((r) => r.id === output?.runId)
  if (!progress) return null
  const accepted = progress.checks.flatMap((_check, position) => {
    const execution = validationExecution(progress, position)
    return execution &&
      acceptedPositions(failures, execution.runId).includes(position - execution.start)
      ? [position]
      : []
  })
  return (
    <section aria-label="Validate results">
      <ChecksRow
        checks={progress.checks}
        accepted={accepted}
        onOpen={(position) => {
          const execution = validationExecution(progress, position)
          if (execution) setOutput({ runId: execution.runId, position: position - execution.start })
        }}
      />
      {failures
        .filter((f) => f.validation && acceptedFailure(f))
        .map((f) => (
          <FailureDetails key={f.id} failure={f} />
        ))}
      {run && output && (
        <CheckOutputDialog
          checkRun={run}
          position={output.position}
          onClose={() => setOutput(undefined)}
        />
      )}
    </section>
  )
}
