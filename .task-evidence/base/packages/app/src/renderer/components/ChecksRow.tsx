import { type CheckResult, checkFailed, checkLabel } from '@ted/protocol/checks'
import type { Judgment } from '@ted/protocol/task'
import styles from './ChecksRow.module.css'

const glyphs: Record<CheckResult['state'], string> = {
  passed: '✓',
  failed: '✗',
  'timed-out': '✗',
  skipped: '–',
  'not-run': '–',
  running: '…',
  waiting: '–',
}

export function checkDetail(check: CheckResult): string | undefined {
  switch (check.state) {
    case 'timed-out':
      return `timed out after ${check.timeout}`
    case 'failed':
      return check.exitCode === 127 ? 'command not found' : undefined
    case 'skipped':
      return 'skipped, no changes'
    case 'not-run':
      return 'not run'
    case 'running':
      return 'running'
    case 'waiting':
      return 'waiting'
    default:
      return undefined
  }
}

const tone = (check: CheckResult) =>
  checkFailed(check.state)
    ? styles.failed
    : check.state === 'passed'
      ? styles.passed
      : check.state === 'running'
        ? styles.running
        : styles.quiet

export function outputCheck(checks: readonly CheckResult[]): number {
  const failed = checks.findIndex((c) => checkFailed(c.state))
  if (failed !== -1) return failed
  const ran = checks.findLastIndex((c) => c.state === 'passed' || c.state === 'running')
  return ran
}

export function judgmentNotes(judgment: Judgment): string | undefined {
  if (judgment.notes === undefined || judgment.notes === 0) return undefined
  return `${judgment.notes} ${judgment.notes === 1 ? 'note' : 'notes'}`
}

export function ChecksRow({
  checks,
  judgments = [],
  onOpen,
  accepted = [],
}: {
  accepted?: readonly number[]
  checks: readonly CheckResult[]
  judgments?: readonly Judgment[]
  onOpen: (position: number) => void
}) {
  const output = outputCheck(checks)
  return (
    <ul className={styles.row} aria-label="Checks">
      {checks.map((check, position) => {
        const detail =
          accepted.includes(position) && checkFailed(check.state)
            ? 'failed, accepted by you'
            : checkDetail(check)
        const ran =
          check.state !== 'skipped' && check.state !== 'not-run' && check.state !== 'waiting'
        const text = (
          <>
            <span className={styles.glyph}>{glyphs[check.state]}</span>
            {checkLabel(check)}
            {detail !== undefined && <span className={styles.detail}> · {detail}</span>}
          </>
        )
        return (
          <li
            key={`${check.name}:${check.repo ?? ''}:${check.builtIn ?? ''}`}
            className={`${styles.check} ${tone(check)}`}
          >
            {ran ? (
              <button
                type="button"
                className={styles.open}
                title={`Open ${checkLabel(check)}’s output`}
                onClick={() => onOpen(position)}
              >
                {text}
              </button>
            ) : (
              text
            )}
          </li>
        )
      })}
      {judgments.map((judgment) => {
        const notes = judgmentNotes(judgment)
        return (
          <li
            key={judgment.name}
            className={`${styles.check} ${judgment.passed ? styles.passed : styles.failed}`}
          >
            <span className={styles.glyph}>{judgment.passed ? '✓' : '✗'}</span>
            {judgment.name}
            {notes !== undefined && <span className={styles.detail}> · {notes}</span>}
          </li>
        )
      })}
      {output !== -1 && (
        <li className={styles.check}>
          <button type="button" className={styles.output} onClick={() => onOpen(output)}>
            Output
          </button>
        </li>
      )}
    </ul>
  )
}
