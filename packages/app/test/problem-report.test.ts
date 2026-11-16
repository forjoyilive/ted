import { maxProblemDescription } from '@ted/protocol/problem-report'
import { describe, expect, test } from 'vitest'
import {
  feedbackEnvelope,
  type Post,
  type SendDeps,
  sendProblemReport,
  sentryTarget,
} from '../src/problem-report.ts'

const dsn = 'https://abc123@o1.ingest.us.sentry.io/42'

describe('sentryTarget', () => {
  test('turns a DSN into its envelope URL and public key', () => {
    expect(sentryTarget(dsn, { allowLoopbackHttp: false })).toEqual({
      url: 'https://o1.ingest.us.sentry.io/api/42/envelope/',
      key: 'abc123',
    })
    expect(
      sentryTarget('https://k@sentry.example.com/base/7', { allowLoopbackHttp: false }),
    ).toEqual({ url: 'https://sentry.example.com/base/api/7/envelope/', key: 'k' })
  })

  test('refuses plain HTTP unless it is a loopback test address', () => {
    expect(
      sentryTarget('http://k@sentry.example.com/7', { allowLoopbackHttp: true }),
    ).toBeUndefined()
    expect(sentryTarget('http://k@127.0.0.1:9/7', { allowLoopbackHttp: false })).toBeUndefined()
    expect(sentryTarget('http://k@127.0.0.1:9/7', { allowLoopbackHttp: true })).toEqual({
      url: 'http://127.0.0.1:9/api/7/envelope/',
      key: 'k',
    })
  })

  test('refuses a DSN without a key or project, or with a password', () => {
    for (const bad of [
      'https://o1.ingest.sentry.io/42',
      'https://k@o1.ingest.sentry.io/',
      'https://k@o1.ingest.sentry.io/abc',
      'https://k:secret@o1.ingest.sentry.io/42',
      'not a url',
    ]) {
      expect(sentryTarget(bad, { allowLoopbackHttp: true }), bad).toBeUndefined()
    }
  })
})

test('a feedback envelope holds the header, the feedback event and the report attachment', () => {
  const body = Buffer.from(
    feedbackEnvelope({
      eventId: 'e'.repeat(32),
      sentAt: new Date('2026-11-16T12:00:00.000Z'),
      dsn,
      description: 'The Board froze.',
      email: '',
      report: 'TED 1.2.3\nDaemon log\nline é',
      environment: 'release',
      release: '1.2.3',
    }),
  ).toString('utf8')
  const lines = body.split('\n')
  expect(JSON.parse(lines[0] ?? '')).toEqual({
    event_id: 'e'.repeat(32),
    sent_at: '2026-11-16T12:00:00.000Z',
    dsn,
    sdk: { name: 'ted', version: '1.2.3' },
  })
  expect(JSON.parse(lines[1] ?? '')).toEqual({ type: 'feedback' })
  const event = JSON.parse(lines[2] ?? '')
  expect(event).toMatchObject({
    event_id: 'e'.repeat(32),
    timestamp: Date.parse('2026-11-16T12:00:00.000Z') / 1000,
    environment: 'release',
    release: '1.2.3',
    contexts: { feedback: { message: 'The Board froze.', source: 'report-a-problem' } },
  })
  expect(event.contexts.feedback).not.toHaveProperty('contact_email')
  expect(JSON.parse(lines[3] ?? '')).toEqual({
    type: 'attachment',
    length: Buffer.byteLength('TED 1.2.3\nDaemon log\nline é'),
    filename: 'report.txt',
    content_type: 'text/plain',
    attachment_type: 'event.attachment',
  })
  expect(lines.slice(4).join('\n')).toBe('TED 1.2.3\nDaemon log\nline é\n')
})

describe('sendProblemReport', () => {
  function deps(answer: Awaited<ReturnType<Post>> | Error, report?: string) {
    const posts: { url: string; init: RequestInit }[] = []
    const asked: boolean[] = []
    const given: SendDeps = {
      dsn,
      allowLoopbackHttp: false,
      version: '1.2.3',
      edition: 'dev',
      now: () => new Date('2026-11-16T12:00:00.000Z'),
      report: async (includeLog) => {
        asked.push(includeLog)
        return report
      },
      post: async (url, init) => {
        posts.push({ url, init })
        if (answer instanceof Error) throw answer
        return answer
      },
    }
    const sent = () => Buffer.from(posts[0]?.init.body as Uint8Array).toString('utf8')
    return { given, posts, asked, sent }
  }

  test('posts one redacted envelope and returns its event ID', async () => {
    const { given, posts, asked, sent } = deps(
      { ok: true, status: 200 },
      'TED 1.2.3\ntoken ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    )
    const result = await sendProblemReport(
      {
        description: 'Pushed with https://me:pw@github.com/k/n.git',
        email: 'me@example.com',
        includeLog: false,
      },
      given,
    )
    expect(result).toMatchObject({ sent: true })
    expect(asked).toEqual([false])
    expect(posts).toHaveLength(1)
    expect(posts[0]?.url).toBe('https://o1.ingest.us.sentry.io/api/42/envelope/')
    expect(posts[0]?.init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': 'Sentry sentry_version=7, sentry_key=abc123, sentry_client=ted/1.2.3',
      },
    })
    const body = sent()
    expect(body).toContain(result.sent ? result.eventId : 'missing')
    expect(body).toContain('"environment":"dev"')
    expect(body).toContain('"contact_email":"me@example.com"')
    expect(body).toContain('https://[redacted]@github.com/k/n.git')
    expect(body).not.toContain('ghp_')
    expect(body).not.toContain('me:pw')
  })

  test('with the daemon not answering, sends what the app knows', async () => {
    const { given, sent } = deps({ ok: true, status: 200 }, undefined)
    await sendProblemReport({ description: 'x', email: '', includeLog: true }, given)
    expect(sent()).toContain('TED 1.2.3 (dev)')
    expect(sent()).toContain('The daemon’s report couldn’t be read')
  })

  test('with the daemon hanging, sends what the app knows once the deadline passes', async () => {
    const { given, sent } = deps({ ok: true, status: 200 })
    const result = await sendProblemReport(
      { description: 'x', email: '', includeLog: true },
      { ...given, reportTimeoutMs: 10, report: () => new Promise<string>(() => {}) },
    )
    expect(result).toMatchObject({ sent: true })
    expect(sent()).toContain('The daemon’s report couldn’t be read')
  })

  test('keeps the message within Sentry’s 4,096 code points after redaction', async () => {
    const { given, sent } = deps({ ok: true, status: 200 }, 'r')
    const secret = 'Bearer abc '
    const description = `${secret}${'y'.repeat(maxProblemDescription - secret.length)}`
    await sendProblemReport({ description, email: '', includeLog: true }, given)
    const event = JSON.parse(sent().split('\n')[2] ?? '')
    const message: string = event.contexts.feedback.message
    expect([...message]).toHaveLength(maxProblemDescription)
    expect(message.startsWith('Bearer [redacted] y')).toBe(true)
  })

  test('says why a report wasn’t sent', async () => {
    const request = { description: 'x', email: '', includeLog: true }
    expect(await sendProblemReport(request, deps({ ok: false, status: 429 }, 'r').given)).toEqual({
      sent: false,
      error: 'Sentry is getting too many reports. Try again in a few minutes.',
    })
    expect(await sendProblemReport(request, deps({ ok: false, status: 500 }, 'r').given)).toEqual({
      sent: false,
      error: 'Sentry turned the report down (HTTP 500).',
    })
    expect(await sendProblemReport(request, deps(new Error('offline'), 'r').given)).toEqual({
      sent: false,
      error: 'TED couldn’t reach Sentry. Check your internet connection.',
    })
    const bad = deps({ ok: true, status: 200 }, 'r')
    expect(
      await sendProblemReport(request, { ...bad.given, dsn: 'http://k@sentry.example.com/1' }),
    ).toEqual({ sent: false, error: 'TED’s Sentry address isn’t valid.' })
    expect(bad.posts).toEqual([])
  })
})
