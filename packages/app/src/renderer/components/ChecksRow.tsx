import { type CheckResult, checkFailed, checkLabel } from '@ted/protocol'
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

export function ChecksRow({
  checks,
  onOpen,
}: {
  checks: readonly CheckResult[]
  onOpen: (position: number) => void
}) {
  const output = outputCheck(checks)
  return (
    <ul className={styles.row} aria-label="Checks">
      {checks.map((check, position) => {
        const detail = checkDetail(check)
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
