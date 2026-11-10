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

export function FailureDetails({
  failure,
  requestId,
}: {
  failure: FailureCase
  requestId?: string
}) {
  const request = requestId ? failure.decisions.find((d) => d.commentId === requestId) : undefined
  const assessment = request
    ? failure.assessments.find((a) => a.id === request.assessmentId)
    : failure.assessments.at(-1)
  const decision = requestId
    ? failure.resolutions.find((r) => r.requestId === requestId)
    : failure.resolutions.at(-1)
  const accepted =
    decision?.resolution === 'accepted' &&
    !failure.invalidations.some((i) => i.requestId === decision.requestId)
  const disposition = requestId
    ? accepted
      ? 'failed, accepted by you'
      : decision?.resolution === 'accepted'
        ? 'acceptance invalidated'
        : (decision?.resolution ?? 'unresolved')
    : acceptedFailure(failure)
      ? 'failed, accepted by you'
      : failure.invalidations.length && decision?.resolution === 'accepted'
        ? 'acceptance invalidated'
        : failure.verifications?.at(-1)?.replacedBy
          ? 'retry failed again; see the new failure'
          : failure.verifications?.length
            ? failure.verifications.at(-1)?.checkRunId
              ? 'verified by a later execution'
              : 'verified with recorded evidence'
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
      {failure.additions
        .slice(0, requestId ? assessment?.evidenceCount : undefined)
        .map((addition) => (
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
      {!requestId &&
        failure.verifications?.map((verification) => (
          <p key={`${verification.at}:${verification.evidence}`} className={styles.sectionBody}>
            Verification: {verification.evidence}
          </p>
        ))}
      <p className={styles.sectionBody}>
        Tested context: {(requestId ? request?.contextId : failure.contextId) ?? 'unknown'}
      </p>
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
    <FailureDetails failure={failure} requestId={requestId} />
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
