import type { Comment, MessageBox, RepairSelection, Task } from '@ted/protocol'
import { shortReference } from '@ted/protocol/reference'
import { useId, useRef, useState } from 'react'
import { useFailures, useTasks } from '../data.ts'
import { draftField, useMessageDraft } from '../message-drafts.ts'
import { readableError, ted } from '../ted.ts'
import { BlockerPicker } from './BlockerPicker.tsx'
import { Button } from './Button.tsx'
import styles from './FailureRepairForm.module.css'
import grow from './TextGrow.module.css'

export function FailureRepairForm({
  id,
  active,
  task,
  request,
  onCancel,
  reason,
  onSendingChange,
  box,
}: {
  id: string
  box?: MessageBox | undefined
  active: boolean
  task: Task
  request: Comment
  onSendingChange(sending: boolean): void
  onCancel(): void
  reason?: string | undefined
}) {
  const failure = useFailures(task.id).find((f) =>
    f.decisions.some((d) => d.commentId === request.id),
  )
  const tasks = useTasks().filter(
    (t) => t.factoryId === task.factoryId && t.id !== task.id && !t.archived && t.stage !== 'done',
  )
  const kept = useMessageDraft(box)
  const optionalText = (value: unknown): value is string | undefined =>
    value === undefined || typeof value === 'string'
  const [kind, setKind] = draftField<'existing' | 'new'>(
    kept,
    'repairKind',
    'existing',
    (value): value is 'existing' | 'new' => value === 'existing' || value === 'new',
  )
  const [selected, setSelected] = draftField(kept, 'repairTask', undefined, optionalText)
  const [title, setTitle] = draftField(kept, 'repairTitle', undefined, optionalText)
  const [description, setDescription] = draftField(
    kept,
    'repairDescription',
    undefined,
    optionalText,
  )
  const [start, setStart] = draftField(
    kept,
    'repairStart',
    true,
    (value): value is boolean => typeof value === 'boolean',
  )
  const [sending, setSending] = useState(false)
  const inFlight = useRef(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string>()
  const group = useId()
  if (!failure) return <p>Loading failure evidence…</p>
  const assessment = failure.assessments.find(
    (a) => a.id === failure.decisions.find((d) => d.commentId === request.id)?.assessmentId,
  )
  const draftTitle =
    title ??
    `Repair ${failure.source.kind === 'finding' ? failure.source.finding : (failure.originalCheck?.name ?? 'verification failure')}`.slice(
      0,
      200,
    )
  const draftDescription =
    description ??
    [
      `Repair the separate problem found while validating ${task.displayId}: ${task.title}.`,
      `Failure ${shortReference(failure.id)}\nOriginal tested context: ${failure.contextId ? shortReference(failure.contextId) : 'unknown'}\n\n${failure.evidence}`,
      ...failure.additions.map((a) => a.evidence),
      `Assessment: ${assessment?.assessment ?? 'uncertain'}\nRecommendation: ${assessment?.recommendation ?? ''}`,
      'Success: repair the reported problem and pass the relevant verification. The affected Task must incorporate the merged repair and run fresh validation.',
    ]
      .join('\n\n')
      .slice(0, 16000)
  const repair = tasks.find((t) => t.id === selected)
  const valid = kind === 'existing' ? !!repair : !!draftTitle.trim() && !!draftDescription.trim()
  async function approve() {
    if (!failure || !active || !valid || inFlight.current || done) return
    inFlight.current = true
    const selection: RepairSelection =
      kind === 'existing'
        ? { kind, taskId: selected ?? '' }
        : { kind, title: draftTitle, description: draftDescription, start }
    setSending(true)
    onSendingChange(true)
    setError(undefined)
    try {
      await ted.resolveFailure(task.id, failure.id, {
        requestId: request.id,
        resolution: 'repair',
        repair: selection,
        ...(reason?.trim() && { reason: reason.trim() }),
      })
      setDone(true)
    } catch (error) {
      setError(readableError(error))
    } finally {
      inFlight.current = false
      setSending(false)
      onSendingChange(false)
    }
  }
  if (done)
    return (
      <p className={styles.notice}>
        Repair selected. This Task is waiting for it to merge; the original failure remains
        recorded.
      </p>
    )
  return (
    <section aria-label="Wait for a repair Task">
      <form
        id={id}
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault()
          void approve()
        }}
      >
        <h3 className={styles.heading}>Wait for a repair Task</h3>
        <fieldset disabled={sending || !active} className={styles.fields}>
          <legend>Choose work in this Factory</legend>
          <label className={styles.choice}>
            <input
              type="radio"
              name={group}
              checked={kind === 'existing'}
              onChange={() => setKind('existing')}
            />
            Use an existing Task
          </label>
          <label className={styles.choice}>
            <input
              type="radio"
              name={group}
              checked={kind === 'new'}
              onChange={() => setKind('new')}
            />
            Create a repair Task
          </label>
          {kind === 'existing' ? (
            <>
              <BlockerPicker
                addLabel={repair ? 'Change repair' : 'Choose repair'}
                tasks={tasks}
                blockers={repair ? [repair] : []}
                onAdd={setSelected}
                onRemove={() => setSelected(undefined)}
              />
              <p className={styles.caption}>
                {repair ? `${repair.displayId} · ${repair.stage}. ` : ''}The selected Task keeps its
                current running or Backlog state.
              </p>
            </>
          ) : (
            <>
              <label className={styles.label}>
                Repair title
                <input
                  className={styles.input}
                  value={draftTitle}
                  maxLength={200}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <label className={styles.label}>
                Repair description
                <textarea
                  className={`${styles.description} ${grow.text}`}
                  value={draftDescription}
                  maxLength={16000}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
              <label className={styles.choice}>
                <input
                  type="checkbox"
                  checked={start}
                  onChange={(e) => setStart(e.target.checked)}
                />
                Queue the repair to start after approval
              </label>
            </>
          )}
        </fieldset>
        {reason?.trim() && <p className={styles.caption}>Your comment: {reason.trim()}</p>}
        <p className={styles.notice}>
          {task.displayId} will keep its Stage and worktree. Its Task Lead will stop, freeing its
          working-Run slot. When the repair merges, TED will queue continuation, incorporate the
          repair and run fresh validation.
        </p>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <div className={styles.buttons}>
          <Button disabled={sending || !active} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            pending={sending}
            disabled={sending || !active || !valid}
          >
            Send
          </Button>
        </div>
      </form>
    </section>
  )
}
