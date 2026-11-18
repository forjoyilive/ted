import type {
  CheckRun,
  Comment,
  FailureCase,
  ValidationProgress,
  ValidationSnapshot,
} from '@ted/protocol'
import { ciFailureLabel, failureChoiceLabels, validationExecution } from '@ted/protocol/failures'
import { shortReference } from '@ted/protocol/reference'
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
  const [open, setOpen] = useState(false)
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
              : failure.validation && failure.source.kind === 'github-ci'
                ? 'closed by Ted'
                : 'verified with recorded evidence'
            : (decision?.resolution ?? 'unresolved')
  const contextId = requestId ? request?.contextId : failure.contextId
  const what =
    failure.source.kind === 'finding'
      ? failure.source.finding
      : failure.source.kind === 'github-ci'
        ? ciFailureLabel(failure.source)
        : `The ${failure.originalCheck?.name ?? 'Factory'} check`
  const additions = failure.additions.slice(0, requestId ? assessment?.evidenceCount : undefined)
  const entries = 1 + additions.length
  return (
    <section className={styles.content} aria-label="Failure assessment and decision">
      <h3 className={styles.sectionHeading}>What failed</h3>
      <p className={styles.failedWhat}>{what}</p>
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
      <details className={styles.history} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          {`${open ? 'Hide' : 'Show'} history · ${entries} evidence ${entries === 1 ? 'entry' : 'entries'}`}
        </summary>
        <p className={styles.sectionBody}>
          Failure{' '}
          <span className={styles.historyId} title={failure.id}>
            {shortReference(failure.id)}
          </span>{' '}
          · {disposition}
        </p>
        <p className={styles.sectionBody}>{failure.evidence}</p>
        {additions.map((addition) => (
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
          Tested context:{' '}
          <span className={styles.historyId} title={contextId}>
            {contextId ? shortReference(contextId) : 'unknown'}
          </span>
        </p>
      </details>
      <p className={styles.caption}>
        {noAccept
          ? failure.validation
            ? 'This failure can’t be accepted: Ted can’t tie it to the Task’s code as it is now.'
            : 'This failure can’t be accepted: Ted can’t tie it to the Task’s code as it is now. If it still happens, send a message to the Task Lead instead of choosing.'
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
  const waiting = affected?.blockedBy.includes(repair.id)
  const closes =
    'Fresh passing checks close this failure. If this Task is stopped, use Resume in Task details first.'
  const fixedBy = failure.verifications?.findLast((v) => v.fixedBy)?.fixedBy
  const message = !affected
    ? 'Loading repair status…'
    : incorporated
      ? failure.verifications?.length
        ? 'Merged repair incorporated. Later verification is recorded; the original execution remains failed.'
        : 'Merged repair incorporated. Fresh validation is required; the original execution remains failed.'
      : current?.stage === 'done'
        ? 'Repair merged. Continuation waits for a working-Run slot and repair incorporation before fresh validation.'
        : failure.verifications?.length
          ? 'Repair dropped without merging. Later verification closed this failure; the original execution remains failed.'
          : current && !current.archived && waiting
            ? 'Waiting for the repair to merge. This Task keeps its Stage and worktree without a working-Run slot.'
            : waiting
              ? `Repair ${current ? 'archived' : 'deleted'} without merging, and this Task still waits on it. Remove the blocker in Task details to stop waiting.`
              : !current
                ? `Repair deleted without merging. ${closes}`
                : current.archived
                  ? `Repair archived without merging. ${closes}`
                  : `Repair blocker removed without merging. ${closes}`

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
      {fixedBy && (
        <p className={styles.sectionBody}>
          Fixed by{' '}
          {onOpenTask && tasks.some((t) => t.id === fixedBy.id) ? (
            <button
              type="button"
              className={styles.showRequest}
              onClick={() => onOpenTask(fixedBy.id)}
            >
              {fixedBy.displayId} · {fixedBy.title}
            </button>
          ) : (
            `${fixedBy.displayId} · ${fixedBy.title}`
          )}
        </p>
      )}
    </>
  )
}

export function useRecommendedChoice(request: Comment): string | undefined {
  const failures = useFailures(request.taskId)
  const failure = failures.find((f) => f.decisions.some((d) => d.commentId === request.id))
  const asked = failure?.decisions.find((d) => d.commentId === request.id)
  const choice = failure?.assessments.find((a) => a.id === asked?.assessmentId)?.choice
  const label = choice && failureChoiceLabels[choice]
  return label && request.choices?.includes(label) ? label : undefined
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
