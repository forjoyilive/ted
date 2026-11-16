import { randomUUID } from 'node:crypto'
import os from 'node:os'
import { redactSecrets } from '@ted/daemon/redact'
import type { Edition, ProblemReportRequest, ProblemReportResult } from '@ted/protocol'

export interface SentryTarget {
  url: string
  key: string
}

export interface FeedbackReport {
  eventId: string
  sentAt: Date
  dsn: string
  description: string
  email: string
  report: string
  environment: Edition
  release: string
}

export type Post = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>

export interface SendDeps {
  dsn: string
  allowLoopbackHttp: boolean
  version: string
  edition: Edition
  report: (includeLog: boolean) => Promise<string | undefined>
  post: Post
  now?: () => Date
  timeoutMs?: number
}

const loopbackHosts = ['127.0.0.1', 'localhost', '[::1]']

export function sentryTarget(
  dsn: string,
  { allowLoopbackHttp }: { allowLoopbackHttp: boolean },
): SentryTarget | undefined {
  const url = URL.parse(dsn)
  if (!url || url.username === '' || url.password !== '' || url.search !== '') return undefined
  const segments = url.pathname.split('/').filter((segment) => segment !== '')
  const project = segments.pop()
  if (project === undefined || !/^\d+$/.test(project)) return undefined
  const secure = url.protocol === 'https:'
  const loopbackTest =
    allowLoopbackHttp && url.protocol === 'http:' && loopbackHosts.includes(url.hostname)
  if (!secure && !loopbackTest) return undefined
  const prefix = segments.map((segment) => `/${segment}`).join('')
  return {
    url: `${url.protocol}//${url.host}${prefix}/api/${project}/envelope/`,
    key: url.username,
  }
}

export function newEventId(): string {
  return randomUUID().replaceAll('-', '')
}

export function feedbackEnvelope(report: FeedbackReport): Uint8Array<ArrayBuffer> {
  const { eventId, sentAt, dsn, description, email, environment, release } = report
  const feedback = {
    message: description,
    ...(email !== '' && { contact_email: email }),
    source: 'report-a-problem',
  }
  const event = {
    event_id: eventId,
    timestamp: sentAt.getTime() / 1000,
    platform: 'javascript',
    level: 'info',
    environment,
    release,
    contexts: {
      feedback,
      os: { name: os.type(), version: os.release() },
    },
  }
  const attachment = Buffer.from(report.report, 'utf8')
  const head = [
    {
      event_id: eventId,
      sent_at: sentAt.toISOString(),
      dsn,
      sdk: { name: 'ted', version: release },
    },
    { type: 'feedback' },
    event,
    {
      type: 'attachment',
      length: attachment.length,
      filename: 'report.txt',
      content_type: 'text/plain',
      attachment_type: 'event.attachment',
    },
  ]
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(`${head.map((part) => JSON.stringify(part)).join('\n')}\n`, 'utf8'),
      attachment,
      Buffer.from('\n', 'utf8'),
    ]),
  )
}

export function appOnlyReport({
  version,
  edition,
  now,
}: {
  version: string
  edition: Edition
  now: Date
}): string {
  return [
    `TED ${version} (${edition})`,
    `Created ${now.toISOString()}`,
    `${os.type()} ${os.release()} ${os.arch()}`,
    '',
    'The daemon’s report couldn’t be read: TED’s background service didn’t answer.',
  ].join('\n')
}

export type ReportSources = Pick<SendDeps, 'version' | 'edition' | 'report' | 'now'>

export async function reportText(
  deps: ReportSources,
  includeLog: boolean,
): Promise<{ text: string; daemon: boolean }> {
  const now = deps.now?.() ?? new Date()
  const text = await deps.report(includeLog).catch(() => undefined)
  return text === undefined
    ? { text: appOnlyReport({ version: deps.version, edition: deps.edition, now }), daemon: false }
    : { text: redactSecrets(text), daemon: true }
}

export async function sendProblemReport(
  request: ProblemReportRequest,
  deps: SendDeps,
): Promise<ProblemReportResult> {
  const target = sentryTarget(deps.dsn, { allowLoopbackHttp: deps.allowLoopbackHttp })
  if (!target) return { sent: false, error: 'TED’s Sentry address isn’t valid.' }
  const sentAt = deps.now?.() ?? new Date()
  const eventId = newEventId()
  const { text } = await reportText(deps, request.includeLog)
  const body = feedbackEnvelope({
    eventId,
    sentAt,
    dsn: deps.dsn,
    description: redactSecrets(request.description),
    email: redactSecrets(request.email),
    report: text,
    environment: deps.edition,
    release: deps.version,
  })
  try {
    const answer = await deps.post(target.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${target.key}, sentry_client=ted/${deps.version}`,
      },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
    })
    if (answer.ok) return { sent: true, eventId }
    if (answer.status === 429) {
      return {
        sent: false,
        error: 'Sentry is getting too many reports. Try again in a few minutes.',
      }
    }
    return { sent: false, error: `Sentry turned the report down (HTTP ${answer.status}).` }
  } catch {
    return { sent: false, error: 'TED couldn’t reach Sentry. Check your internet connection.' }
  }
}
