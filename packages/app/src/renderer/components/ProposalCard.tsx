import type { AnswerRequest, MessageBox, Proposal, ProposalCreated } from '@ted/protocol'
import { planProposal } from '@ted/protocol/proposal'
import { sendOnEnter } from '../composer-keys.ts'
import { draftField, useMessageDraft } from '../message-drafts.ts'
import { blockedByText, createLabel, droppedWarning, wouldStart } from '../proposal.ts'
import { priorityLabels } from '../task-fields.ts'
import { Button } from './Button.tsx'
import { PriorityIcon } from './PriorityIcon.tsx'
import styles from './ProposalCard.module.css'

function RowTitle({
  proposal,
  title,
  first,
  onOpenTask,
}: {
  proposal: Proposal
  title: string
  first: boolean
  onOpenTask?: ((id: string) => void) | undefined
}) {
  const piece = proposal.firstPiece
  if (!first || !piece) return <span className={styles.rowTitle}>{title}</span>
  return (
    <span className={styles.rowTitle}>
      {onOpenTask ? (
        <button type="button" className={styles.taskLink} onClick={() => onOpenTask(piece.id)}>
          {piece.displayId}
        </button>
      ) : (
        <span className={styles.taskId}>{piece.displayId}</span>
      )}
      <span className={styles.thisTask}> (this Task) becomes the first piece: </span>
      {title}
    </span>
  )
}

export function ProposalRows({
  proposal,
  skip,
  created,
  disabled,
  onToggle,
  onOpenTask,
}: {
  proposal: Proposal
  skip: readonly number[]
  created?: ProposalCreated | undefined
  disabled: boolean
  onToggle?: (row: number) => void
  onOpenTask?: ((id: string) => void) | undefined
}) {
  const plan = planProposal(proposal, skip)
  const idOf = (row: number) =>
    row === 1 && proposal.firstPiece
      ? proposal.firstPiece.displayId
      : created?.tasks.find((t) => t.row === row)?.displayId
  return (
    <ol className={styles.rows} aria-label="Proposed Tasks">
      {proposal.rows.map((row, i) => {
        const planned = plan.rows[i]
        const number = i + 1
        const first = planned?.first === true
        const kept = first || !skip.includes(number)
        const warning = planned && droppedWarning(planned)
        const madeId = created && !first ? idOf(number) : undefined
        const blockers = kept ? (planned?.blockedBy ?? []) : row.blockedBy
        const dropped = planned?.dropped ?? []
        return (
          <li
            key={`${number}-${row.title}`}
            className={kept ? styles.row : `${styles.row} ${styles.skipped}`}
          >
            <input
              type="checkbox"
              className={styles.check}
              aria-label={`Create row ${number}: ${row.title}`}
              checked={kept}
              disabled={disabled || first || onToggle === undefined}
              onChange={() => onToggle?.(number)}
            />
            <span className={styles.number}>{number}</span>
            <div className={styles.body}>
              <div className={styles.line}>
                <RowTitle
                  proposal={proposal}
                  title={row.title}
                  first={first}
                  onOpenTask={onOpenTask}
                />
                {madeId !== undefined && <span className={styles.madeId}>{madeId}</span>}
                <span className={styles.priority}>
                  <PriorityIcon priority={row.priority} />
                  {priorityLabels[row.priority]}
                </span>
                <span className={styles.blockers}>
                  {blockers.length === 0 && dropped.length > 0
                    ? null
                    : created && kept
                      ? blockers.length === 0
                        ? '—'
                        : `blocked by ${blockers.map((b) => idOf(b) ?? b).join(', ')}`
                      : blockedByText(blockers)}
                  {dropped.length > 0 && <s className={styles.struck}>{blockedByText(dropped)}</s>}
                </span>
              </div>
              <p className={styles.scope}>{row.scope}</p>
              {warning !== undefined && !created && (
                <p className={styles.warning}>
                  <span aria-hidden>⚠ </span>
                  {warning}
                </p>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

export function ProposalAnswer({
  proposal,
  readOnly,
  sending,
  onSend,
  onOpenTask,
  box,
}: {
  proposal: Proposal
  box?: MessageBox | undefined
  readOnly: boolean
  sending: boolean
  onSend: (answer: AnswerRequest) => void
  onOpenTask?: ((id: string) => void) | undefined
}) {
  const kept = useMessageDraft(box)
  const { text, setText } = kept
  const [skip, setSkip] = draftField(
    kept,
    'skip',
    [],
    (value): value is number[] =>
      Array.isArray(value) && value.every((row) => typeof row === 'number'),
  )
  const [startUnblocked, setStartUnblocked] = draftField(
    kept,
    'startUnblocked',
    false,
    (value): value is boolean => typeof value === 'boolean',
  )
  const plan = planProposal(proposal, skip)
  const typed = text.trim() !== ''
  const toggle = (row: number) =>
    setSkip(skip.includes(row) ? skip.filter((r) => r !== row) : [...skip, row])
  return (
    <>
      <ProposalRows
        proposal={proposal}
        skip={skip}
        disabled={readOnly || sending}
        {...(!readOnly && { onToggle: toggle })}
        onOpenTask={onOpenTask}
      />
      {!readOnly && (
        <>
          <label className={styles.startUnblocked}>
            <input
              type="checkbox"
              className={styles.check}
              checked={startUnblocked}
              disabled={sending}
              onChange={(event) => setStartUnblocked(event.target.checked)}
            />
            Start the unblocked ones
            <span className={styles.wouldStart}>{wouldStart(plan.unblocked)}</span>
          </label>
          <textarea
            className={styles.box}
            aria-label="Your answer"
            placeholder="Comment, or say what to change…"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={sendOnEnter(() => {
              if (!sending) onSend({ action: 'request-changes', text })
            })}
          />
          <div className={styles.buttons}>
            <Button
              disabled={sending || !typed}
              onClick={() => onSend({ action: 'request-changes', text })}
            >
              Request changes
            </Button>
            <Button
              variant="primary"
              disabled={sending || plan.creates === 0}
              onClick={() =>
                onSend({
                  action: 'approve',
                  ...(typed && { text }),
                  proposal: { skip, startUnblocked },
                })
              }
            >
              {createLabel(plan.creates)}
            </Button>
          </div>
        </>
      )}
    </>
  )
}
