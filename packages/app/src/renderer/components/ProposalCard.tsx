import type {
  AnswerRequest,
  MessageBox,
  Proposal,
  ProposalCreated,
  ProposalLink,
} from '@ted/protocol'
import { isArray, isInteger, isObject, type Untyped } from '@ted/protocol/parse'
import { planProposal } from '@ted/protocol/proposal'
import { sendOnEnter, signOffEnter } from '../composer-keys.ts'
import { draftField, useMessageDraft } from '../message-drafts.ts'
import {
  blockedByText,
  createLabel,
  droppedWarning,
  hasLink,
  linkReason,
  parentLine,
  tedLinkLead,
  tedLinks,
  tedLinksIntro,
  wouldStart,
} from '../proposal.ts'
import { priorityLabels } from '../task-fields.ts'
import { Button } from './Button.tsx'
import { PriorityIcon } from './PriorityIcon.tsx'
import styles from './ProposalCard.module.css'
import grow from './TextGrow.module.css'

export function ProposalRows({
  proposal,
  skip,
  unlink,
  created,
  disabled,
  onToggle,
  onToggleLink,
  onOpenTask,
}: {
  proposal: Proposal
  skip: readonly number[]
  unlink?: readonly ProposalLink[] | undefined
  created?: ProposalCreated | undefined
  disabled: boolean
  onToggle?: (row: number) => void
  onToggleLink?: (link: ProposalLink) => void
  onOpenTask?: ((id: string) => void) | undefined
}) {
  const removed = unlink ?? created?.unlinked ?? []
  const plan = planProposal(proposal, skip, removed)
  const added = tedLinks(proposal, skip)
  const idOf = (row: number) => created?.tasks.find((t) => t.row === row)?.displayId
  const parent = proposal.firstPiece
  return (
    <>
      {!created && (
        <p className={styles.parentLine} data-parent-line>
          {parent && onOpenTask ? (
            <>
              <button
                type="button"
                className={styles.taskLink}
                onClick={() => onOpenTask(parent.id)}
              >
                {parent.displayId}
              </button>
              {parentLine(proposal).slice(parent.displayId.length)}
            </>
          ) : (
            parentLine(proposal)
          )}
        </p>
      )}
      {added.length > 0 && (
        <div className={styles.tedLinks} data-ted-links>
          <p className={styles.tedLinksIntro}>
            {tedLinksIntro(onToggleLink !== undefined && !created)}
          </p>
          <ul className={styles.tedLinkList}>
            {added.map((link) => (
              <li
                key={`${link.row}-${link.blocker}`}
                className={
                  hasLink(removed, link.row, link.blocker) ? styles.removedLink : undefined
                }
              >
                {tedLinkLead(link)}
                {link.files.map((file, i) => (
                  <span key={file}>
                    {i > 0 && ', '}
                    <code className={styles.file}>{file}</code>
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ol className={styles.rows} aria-label="Proposed Tasks">
        {proposal.rows.map((row, i) => {
          const planned = plan.rows[i]
          const number = i + 1
          const kept = !skip.includes(number)
          const warning = planned && droppedWarning(planned)
          const madeId = created ? idOf(number) : undefined
          const dropped = planned?.dropped ?? []
          const shown = kept
            ? row.blockedBy.filter(
                (b) => planned?.blockedBy.includes(b) || planned?.unlinked.includes(b),
              )
            : []
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
                disabled={disabled || onToggle === undefined}
                onChange={() => onToggle?.(number)}
              />
              <span className={styles.number}>{number}</span>
              <div className={styles.body}>
                <div className={styles.line}>
                  <span className={styles.rowTitle}>{row.title}</span>
                  {madeId !== undefined && <span className={styles.madeId}>{madeId}</span>}
                  <span className={styles.priority}>
                    <PriorityIcon priority={row.priority} />
                    {priorityLabels[row.priority]}
                  </span>
                  <span className={styles.blockers}>
                    {!kept ? (
                      blockedByText(row.blockedBy)
                    ) : shown.length === 0 ? (
                      dropped.length > 0 ? null : (
                        '—'
                      )
                    ) : (
                      <>
                        blocked by
                        {shown.map((blocker) => {
                          const gone = hasLink(removed, number, blocker)
                          const byTed = row.addedBlockedBy?.includes(blocker) === true
                          const label = created
                            ? (idOf(blocker) ?? String(blocker))
                            : String(blocker)
                          return (
                            <span
                              key={blocker}
                              className={[
                                styles.chip,
                                byTed && styles.tedChip,
                                gone && styles.removedChip,
                              ]
                                .filter(Boolean)
                                .join(' ')}
                              title={linkReason(row, blocker)}
                              data-link={`${number}-${blocker}`}
                            >
                              {label}
                              {onToggleLink && !created && (
                                <button
                                  type="button"
                                  className={styles.chipButton}
                                  disabled={disabled}
                                  aria-label={
                                    gone
                                      ? `Put back row ${number}’s link to row ${blocker}`
                                      : `Remove row ${number}’s link to row ${blocker}`
                                  }
                                  title={gone ? 'Put this link back' : 'Remove this link'}
                                  onClick={() => onToggleLink({ row: number, blocker })}
                                >
                                  {gone ? '↺' : '×'}
                                </button>
                              )}
                            </span>
                          )
                        })}
                      </>
                    )}
                    {dropped.length > 0 && (
                      <s className={styles.struck}>{blockedByText(dropped)}</s>
                    )}
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
    </>
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
  const [unlink, setUnlink] = draftField(kept, 'unlink', [], isLinkList)
  const plan = planProposal(proposal, skip, unlink)
  const typed = text.trim() !== ''
  const enter = signOffEnter(typed)
  const approve = () =>
    onSend({
      action: 'approve',
      ...(typed && { text }),
      proposal: { skip, ...(unlink.length > 0 && { unlink }), startUnblocked },
    })
  const toggle = (row: number) =>
    setSkip(skip.includes(row) ? skip.filter((r) => r !== row) : [...skip, row])
  const toggleLink = (link: ProposalLink) =>
    setUnlink(
      hasLink(unlink, link.row, link.blocker)
        ? unlink.filter((l) => l.row !== link.row || l.blocker !== link.blocker)
        : [...unlink, link],
    )
  return (
    <>
      <ProposalRows
        proposal={proposal}
        skip={skip}
        unlink={unlink}
        disabled={readOnly || sending}
        {...(!readOnly && { onToggle: toggle, onToggleLink: toggleLink })}
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
            className={`${styles.box} ${grow.text}`}
            aria-label="Your answer"
            placeholder="Comment, or say what to change…"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={sendOnEnter(
              () => {
                if (sending) return
                if (enter === 'request-changes') onSend({ action: 'request-changes', text })
                else if (plan.creates > 0) approve()
              },
              () => true,
            )}
          />
          <div className={styles.buttons}>
            <Button
              {...(enter === 'request-changes' && { shortcut: '↵' })}
              disabled={sending || !typed}
              onClick={() => onSend({ action: 'request-changes', text })}
            >
              Request changes
            </Button>
            <Button
              variant="primary"
              {...(enter === 'approve' && { shortcut: '↵' })}
              disabled={sending || plan.creates === 0}
              onClick={approve}
            >
              {createLabel(plan.creates)}
            </Button>
          </div>
        </>
      )}
    </>
  )
}

function isLinkList(value: Untyped): value is ProposalLink[] {
  return (
    isArray(value) &&
    value.every((link) => isObject(link) && isInteger(link.row) && isInteger(link.blocker))
  )
}
