import { type CheckRun, checkFailed, checkLabel, type SendBack } from '@ted/protocol'
import type { ReactNode } from 'react'
import { ChecksRow } from '../components/ChecksRow.tsx'
import styles from './CheckEvents.module.css'
import { stageName } from './TaskViews.tsx'

export type CheckEvent =
  | { kind: 'check-run'; id: string; createdAt: string; checkRun: CheckRun; sendBack?: SendBack }
  | { kind: 'send-back'; id: string; createdAt: string; sendBack: SendBack }

export function checkEvents(
  checkRuns: readonly CheckRun[],
  sendBacks: readonly SendBack[],
): CheckEvent[] {
  const linked = new Map(
    sendBacks.flatMap((s) => (s.checkRunId === undefined ? [] : [[s.checkRunId, s] as const])),
  )
  return [
    ...checkRuns.map((checkRun) => {
      const sendBack = linked.get(checkRun.id)
      return {
        kind: 'check-run' as const,
        id: `check-run:${checkRun.id}`,
        createdAt: checkRun.startedAt,
        checkRun,
        ...(sendBack && { sendBack }),
      }
    }),
    ...sendBacks
      .filter((s) => s.checkRunId === undefined || !checkRuns.some((r) => r.id === s.checkRunId))
      .map((sendBack) => ({
        kind: 'send-back' as const,
        id: `send-back:${sendBack.id}`,
        createdAt: sendBack.at,
        sendBack,
      })),
  ]
}

export function sentBackText(sendBack: SendBack): string {
  const round =
    sendBack.round === undefined
      ? ''
      : sendBack.limit === undefined
        ? ` (round ${sendBack.round})`
        : ` (round ${sendBack.round} of ${sendBack.limit})`
  return `${stageName(sendBack.from)} sent this back to ${stageName(sendBack.to)}${round}`
}

type Dot = 'run' | 'created' | 'failed' | 'neutral'

function headline(checkRun: CheckRun, sendBack: SendBack | undefined): [Dot, string] {
  if (sendBack) return ['failed', sentBackText(sendBack)]
  const failed = checkRun.checks.find((c) => checkFailed(c.state))
  if (checkRun.trigger === 'agent') {
    if (checkRun.finishedAt === undefined)
      return ['run', `${stageName(checkRun.stage)} is running Checks`]
    return [failed ? 'failed' : 'run', `${stageName(checkRun.stage)} ran Checks`]
  }
  if (checkRun.finishedAt === undefined) {
    const running = checkRun.checks.findIndex((c) => c.state === 'running')
    const check = checkRun.checks[running]
    return [
      'run',
      check
        ? `Running Checks · ${checkLabel(check)} (${running + 1} of ${checkRun.checks.length})`
        : 'Running Checks',
    ]
  }
  if (checkRun.outcome === 'interrupted') return ['neutral', 'Checks stopped before they finished']
  if (failed) return ['failed', `${checkLabel(failed)} failed at Validate`]
  return ['created', 'Checks passed at Validate']
}

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

function EventLine({
  dot,
  text,
  at,
  children,
}: {
  dot: Dot
  text: string
  at: string
  children?: ReactNode
}) {
  return (
    <li className={styles.event}>
      <span className={`${styles.dot} ${styles[dot]}`} aria-hidden="true" />
      <div className={styles.body}>
        <div className={styles.line}>
          <span className={styles.text}>{text}</span>
          <time className={styles.time} dateTime={at}>
            {time.format(new Date(at))}
          </time>
        </div>
        {children}
      </div>
    </li>
  )
}

export function findingsShown(sendBack: SendBack): string {
  const text = sendBack.findings.trim()
  return sendBack.checkRunId === undefined ? text : (text.split(/\n\s*\n/)[0] ?? text)
}

export function BlockingFindings({ sendBack }: { sendBack: SendBack }) {
  return (
    <section className={styles.findings} aria-label="Blocking findings">
      <h3 className={styles.findingsTitle}>Blocking findings</h3>
      <p className={styles.findingsText}>{findingsShown(sendBack)}</p>
    </section>
  )
}

export function CheckEventLine({
  event,
  onOpenOutput,
}: {
  event: CheckEvent
  onOpenOutput: (checkRun: CheckRun, position: number) => void
}) {
  if (event.kind === 'send-back') {
    return (
      <EventLine dot="failed" text={sentBackText(event.sendBack)} at={event.createdAt}>
        <BlockingFindings sendBack={event.sendBack} />
      </EventLine>
    )
  }
  const { checkRun, sendBack } = event
  const [dot, text] = headline(checkRun, sendBack)
  return (
    <EventLine dot={dot} text={text} at={event.createdAt}>
      <ChecksRow checks={checkRun.checks} onOpen={(position) => onOpenOutput(checkRun, position)} />
      {sendBack && <BlockingFindings sendBack={sendBack} />}
    </EventLine>
  )
}
