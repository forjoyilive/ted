import type { CheckRun, FailureCase, ValidationProgress, ValidationSnapshot } from '@ted/protocol'
import { validationExecution } from '@ted/protocol/failures'
import { useState } from 'react'
import { useCheckRuns, useFailures, useTasks, useValidationObligations } from '../data.ts'
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

const assessmentWords = {
  regression: 'This Task caused it',
  unrelated: 'This Task didn’t cause it',
  uncertain: 'The cause isn’t known',
} as const

export function FailureDetails({
  failure,
  requestId,
  onOpenTask,
  noAccept = false,
}: {
  failure: FailureCase
  requestId?: string
  noAccept?: boolean
  onOpenTask?: ((id: string) => void) | undefined
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
  const what =
    failure.source.kind === 'finding'
      ? failure.source.finding
      : failure.source.kind === 'github-ci'
        ? `CI on ${failure.source.repo}#${failure.source.number}`
        : `The ${failure.originalCheck?.name ?? 'Factory'} Check`
  return (
    <section className={styles.content} aria-label="Failure assessment and decision">
      <h3 className={styles.sectionHeading}>Failed</h3>
      <p className={styles.sectionBody}>{what}</p>
      <h3 className={styles.sectionHeading}>Task Lead’s assessment</h3>
      <p className={styles.sectionBody}>
        {assessment ? assessmentWords[assessment.assessment] : 'Investigation in progress'}
      </p>
      {assessment && (
        <>
          <h3 className={styles.sectionHeading}>Recommendation</h3>
          <p className={styles.sectionBody}>{assessment.recommendation}</p>
        </>
      )}
      {decision?.repairTask && (
        <RepairDetails failure={failure} decision={decision} onOpenTask={onOpenTask} />
      )}
      {decision && (
        <p className={styles.sectionBody}>
          Human decision: {decision.resolution} · {decision.reason}
        </p>
      )}
      <details>
        <summary className={styles.caption}>Evidence and history</summary>
        <p className={styles.sectionBody}>
          Failure {failure.id} · {disposition}
        </p>
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
        {!requestId &&
          failure.verifications?.map((verification) => (
            <p key={`${verification.at}:${verification.evidence}`} className={styles.sectionBody}>
              Verification: {verification.evidence}
            </p>
          ))}
        <p className={styles.sectionBody}>
          Tested context: {(requestId ? request?.contextId : failure.contextId) ?? 'unknown'}
        </p>
      </details>
      <p className={styles.caption}>
        {noAccept
          ? failure.validation
            ? 'This failure can’t be accepted: TED can’t tie it to the Task’s code as it is now.'
            : 'This failure can’t be accepted: TED can’t tie it to the Task’s code as it is now. If it still happens, write to the Task Lead instead of choosing.'
          : 'Accepting covers only this failure. It doesn’t count as passed or approve a merge.'}
      </p>
    </section>
  )
}

function RepairDetails({
  failure,
  decision,
  onOpenTask,
}: {
  failure: FailureCase
  decision: FailureCase['resolutions'][number]
  onOpenTask?: ((id: string) => void) | undefined
}) {
  const tasks = useTasks()
  const repair = decision.repairTask
  if (!repair) return null
  const current = tasks.find((t) => t.id === repair.id)
  const affected = tasks.find((t) => t.id === failure.taskId)
  const incorporated = failure.repairProgress?.some((p) => p.requestId === decision.requestId)
  const message = !affected
    ? 'Loading repair status…'
    : incorporated
      ? failure.verifications?.length
        ? 'Merged repair incorporated. Later verification is recorded; the original execution remains failed.'
        : 'Merged repair incorporated. Fresh validation is required; the original execution remains failed.'
      : current?.stage === 'done'
        ? 'Repair merged. Continuation waits for a working-Run slot and repair incorporation before fresh validation.'
        : !current
          ? 'Repair deleted. The failure remains unresolved unless fresh verification resolves it.'
          : current.archived
            ? 'Repair archived without merging. Check the blocker in Task details; this does not pass validation.'
            : affected.blockedBy.includes(repair.id)
              ? 'Waiting for the repair to merge. This Task keeps its Stage and worktree without a working-Run slot.'
              : 'Repair blocker removed without merging. Use Resume in Task details to reassess the unresolved failure.'

  return (
    <>
      <h3 className={styles.sectionHeading}>Repair Task</h3>
      <p className={styles.sectionBody}>
        {current && onOpenTask ? (
          <button
            type="button"
            className={styles.showRequest}
            onClick={() => onOpenTask(repair.id)}
          >
            {repair.displayId} · {repair.title}
          </button>
        ) : (
          `${repair.displayId} · ${repair.title}`
        )}
      </p>
      <p className={styles.sectionBody}>{message}</p>
    </>
  )
}

export function FailureRequestDetails({
  taskId,
  requestId,
  fallback,
  onOpenTask,
  noAccept,
}: {
  taskId: string
  requestId: string
  fallback: string
  onOpenTask?: ((id: string) => void) | undefined
  noAccept?: boolean
}) {
  const failures = useFailures(taskId)
  const failure = failures.find((f) => f.decisions.some((d) => d.commentId === requestId))
  return failure ? (
    <FailureDetails
      failure={failure}
      requestId={requestId}
      onOpenTask={onOpenTask}
      {...(noAccept && { noAccept })}
    />
  ) : (
    <p className={styles.summary}>{fallback}</p>
  )
}

export function ValidationSummary({ taskId }: { taskId: string }) {
  const failures = useFailures(taskId)
  const obligations = useValidationObligations(taskId)
  const runs = useCheckRuns(taskId)
  return <ValidationResults progress={obligations?.progress} failures={failures} runs={runs} />
}

export function RecordedValidationSummary({
  taskId,
  snapshot,
}: {
  taskId: string
  snapshot: ValidationSnapshot
}) {
  const runs = useCheckRuns(taskId)
  return <ValidationResults progress={snapshot.progress} failures={snapshot.failures} runs={runs} />
}

function ValidationResults({
  progress,
  failures,
  runs,
}: {
  progress: ValidationProgress | undefined
  failures: readonly FailureCase[]
  runs: readonly CheckRun[]
}) {
  const [output, setOutput] = useState<{ runId: string; position: number }>()
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
          failures={failures}
          position={output.position}
          onClose={() => setOutput(undefined)}
        />
      )}
    </section>
  )
}
