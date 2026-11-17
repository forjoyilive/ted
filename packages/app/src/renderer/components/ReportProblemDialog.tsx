import { isReportEmail, maxProblemDescription } from '@ted/protocol/problem-report'
import { useEffect, useState } from 'react'
import { useSettings } from '../data.ts'
import { readableError, ted } from '../ted.ts'
import { Dialog } from './ArchiveDialogs.tsx'
import { Button } from './Button.tsx'
import styles from './ReportProblemDialog.module.css'
import grow from './TextGrow.module.css'

type Step =
  | { kind: 'compose'; error?: string }
  | { kind: 'sending' }
  | { kind: 'sent'; eventId: string }

export function ReportProblemDialog({ onClose }: { onClose: () => void }) {
  const settings = useSettings()
  const [report, setReport] = useState<{ text: string; daemon: boolean }>()
  const [what, setWhat] = useState('')
  const [typedEmail, setTypedEmail] = useState<string>()
  const [includeLog, setIncludeLog] = useState(true)
  const [step, setStep] = useState<Step>({ kind: 'compose' })
  const [copied, setCopied] = useState<'report' | 'id'>()

  useEffect(() => {
    let live = true
    void ted
      .problemReport()
      .then((loaded) => live && setReport(loaded))
      .catch((failure) => live && setReport({ text: readableError(failure), daemon: false }))
    return () => {
      live = false
    }
  }, [])

  const email = typedEmail ?? settings?.reportEmail ?? ''
  const emailProblem = isReportEmail(email.trim())
    ? undefined
    : 'Enter an email address, or leave it empty.'
  const sending = step.kind === 'sending'
  const failed = step.kind === 'compose' ? step.error : undefined

  const send = async () => {
    setStep({ kind: 'sending' })
    try {
      const result = await ted.sendProblemReport({ description: what, email, includeLog })
      setStep(
        result.sent
          ? { kind: 'sent', eventId: result.eventId }
          : { kind: 'compose', error: result.error },
      )
    } catch (failure) {
      setStep({ kind: 'compose', error: readableError(failure) })
    }
  }

  const copy = async (text: string, which: 'report' | 'id') => {
    await ted.copyText(text)
    setCopied(which)
  }

  if (step.kind === 'sent') {
    return (
      <Dialog onClose={onClose} className={styles.dialog}>
        {(heading) => (
          <>
            <div className={styles.sent} data-report-sent="">
              <svg className={styles.mark} viewBox="0 0 56 56" aria-hidden="true">
                <circle cx="28" cy="28" r="28" />
                <path d="M17 29l7.5 7.5L39.5 21" />
              </svg>
              <h2 id={heading} className={`${styles.heading} ${styles.fade}`}>
                Report sent. Thank you.
              </h2>
              <p className={`${styles.lede} ${styles.fade}`}>
                It reached the TED team. If you added an email, they may write to you about it.
              </p>
              <span className={`${styles.eventId} ${styles.fade}`}>
                Event ID <code data-event-id="">{step.eventId}</code>
                <Button size="small" onClick={() => void copy(step.eventId, 'id')}>
                  {copied === 'id' ? 'Copied' : 'Copy'}
                </Button>
              </span>
            </div>
            <div className={styles.footer}>
              <span className={styles.grow} />
              <Button variant="primary" onClick={onClose}>
                Done
              </Button>
            </div>
          </>
        )}
      </Dialog>
    )
  }

  return (
    <Dialog onClose={onClose} className={styles.dialog}>
      {(heading) => (
        <>
          <h2 id={heading} className={styles.heading}>
            Report a problem
          </h2>
          <p className={styles.lede}>
            Tell the TED team what went wrong. Nothing is sent until you click Send.
          </p>
          <label className={styles.field}>
            <span className={styles.label}>What happened</span>
            <textarea
              className={`${styles.input} ${styles.description} ${grow.text}`}
              maxLength={maxProblemDescription}
              value={what}
              disabled={sending}
              placeholder="What were you doing, and what did you expect to happen?"
              onChange={(event) => setWhat(event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>
              Email <span className={styles.optional}>(optional)</span>
            </span>
            <input
              className={styles.input}
              type="email"
              value={email}
              disabled={sending}
              placeholder="you@example.com"
              aria-invalid={emailProblem !== undefined}
              onChange={(event) => setTypedEmail(event.target.value)}
            />
            {emailProblem !== undefined && email.trim() !== '' && (
              <span className={styles.fieldError}>{emailProblem}</span>
            )}
          </label>
          {report?.daemon === false && (
            <p className={styles.notice}>
              TED’s background service isn’t answering, so the report has only what the app knows.
              You can still send it.
            </p>
          )}
          <details className={styles.report} open={report?.daemon === false}>
            <summary>
              <span>Diagnostic report</span>
              <span className={styles.summaryNote}>Tokens and URL passwords removed</span>
            </summary>
            <pre className={styles.reportText}>{report?.text ?? 'Reading the report…'}</pre>
          </details>
          {report?.daemon !== false && (
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={includeLog}
                disabled={sending}
                onChange={(event) => setIncludeLog(event.target.checked)}
              />
              <span>
                Include the log
                <span className={styles.checkNote}>
                  The daemon log and process command lines. Unticked, they’re left out of what’s
                  sent.
                </span>
              </span>
            </label>
          )}
          {failed !== undefined && (
            <div className={styles.error} role="alert">
              <strong>The report wasn’t sent.</strong> {failed} Try again, or copy the report and
              open a GitHub issue.
            </div>
          )}
          <div className={styles.footer}>
            <Button variant="quiet" disabled={sending} onClick={() => void ted.openGitHubIssue()}>
              Open a GitHub issue instead
            </Button>
            <span className={styles.grow} />
            {failed !== undefined ? (
              <Button
                disabled={report === undefined}
                onClick={() => void copy(report?.text ?? '', 'report')}
              >
                {copied === 'report' ? 'Copied' : 'Copy report'}
              </Button>
            ) : (
              <Button disabled={sending} onClick={onClose}>
                Cancel
              </Button>
            )}
            <Button
              variant="primary"
              disabled={sending || what.trim() === '' || emailProblem !== undefined}
              onClick={() => void send()}
            >
              {sending ? 'Sending…' : failed !== undefined ? 'Try again' : 'Send'}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  )
}
