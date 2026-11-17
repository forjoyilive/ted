import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { type Crash, type Edition, maxCrashType } from '@ted/protocol'
import { redactSecrets } from './redact.ts'
import { envelopeRequest, newEventId, type Post, sentryTarget } from './sentry.ts'

export type CrashPart = 'main' | 'renderer' | 'daemon'

export interface CrashReporterOptions {
  part: CrashPart
  dsn: string
  allowLoopbackHttp: boolean
  version: string
  edition: Edition
  enabled: () => boolean
  post: Post
  codeRoots?: readonly string[]
  home?: string
  now?: () => Date
  timeoutMs?: number
}

export interface CrashFrame {
  function?: string
  filename: string
  lineno?: number
  colno?: number
  in_app: boolean
}

export interface CleanCrash {
  type: string
  message: string
  frames: CrashFrame[]
}

export type ReportCrash = (crash: Crash) => Promise<void>

export const maxCrashMessage = 500
export const maxCrashFrames = 50
export const crashesPerHour = 10
const hourMs = 60 * 60_000

export const tedCodeRoot = path.resolve(import.meta.dirname, '..', '..', '..')

const boundary = String.raw`(^|[\s('"\x60=,:[{])`
const pathChars = String.raw`[^\s'"\x60()<>,;]+`
const posixPath = new RegExp(`${boundary}(?:file://|~)?/${pathChars}`, 'gm')
const windowsPath = new RegExp(String.raw`${boundary}[A-Za-z]:\\${pathChars}`, 'gm')

const slashToken = new RegExp(
  String.raw`${boundary}([^\s'"\x60()<>,;]*[/\\][^\s'"\x60()<>,;]*)`,
  'gm',
)
const betweenPaths = /<path>(?:[ \t]+\S+)*[ \t]+<path>/g
const keptPrefixes = ['packages/', 'node:', '<path>', '<anonymous>']

const quotedPath = /(^|[^\w])'(?:<path>|file:\/\/|~?\/|[A-Za-z]:\\)[^\n]*'/gm
const quotedText = /"([^"\n]*)(?:"|$)|\x60([^\x60\n]*)(?:\x60|$)|(^|[^\w])'([^'\n]*)'/gm
const pathLike = /^(?:<path>|file:\/\/|~?\/|[A-Za-z]:\\)/

function placeholder(inside: string): string {
  return pathLike.test(inside) ? '<path>' : '<text>'
}

function withoutQuotedText(text: string): string {
  return text
    .replace(quotedPath, "$1'<path>'")
    .replace(
      quotedText,
      (
        _match,
        double: string | undefined,
        backtick: string | undefined,
        before: string | undefined,
        single: string | undefined,
      ) => {
        if (double !== undefined) return `"${placeholder(double)}"`
        if (backtick !== undefined) return `\x60${placeholder(backtick)}\x60`
        return `${before ?? ''}'${placeholder(single ?? '')}'`
      },
    )
}

function kept(token: string): boolean {
  return keptPrefixes.some((prefix) => token.startsWith(prefix))
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

function rootForms(root: string): string[] {
  const trimmed = root.replace(/[/\\]+$/, '')
  const url = pathToFileURL(trimmed).href
  return [`${url}/`, `${trimmed}/`, `${trimmed}\\`]
}

export function cleanText(text: string, roots: readonly string[], home: string): string {
  let result = text
  for (const root of [...roots].sort((a, b) => b.length - a.length)) {
    for (const form of rootForms(root)) result = result.replaceAll(form, '')
  }
  if (home.length > 1) {
    const homeTail = String.raw`(?:[/\\][^'"\x60()\n]*)?`
    const homeUrl = escapeRegExp(pathToFileURL(home).href)
    result = result.replace(new RegExp(`${homeUrl}${homeTail}`, 'g'), '<path>')
    result = result.replace(new RegExp(`${escapeRegExp(home)}${homeTail}`, 'g'), '<path>')
  }
  result = withoutQuotedText(result)
    .replace(posixPath, '$1<path>')
    .replace(windowsPath, '$1<path>')
    .replace(slashToken, (match, before: string, token: string) =>
      kept(token) ? match : `${before}<path>`,
    )
    .replace(betweenPaths, '<path>')
  return redactSecrets(result)
}

const frameLine = /^\s*at (?:(.+?) \((.+)\)|(.+))$/

function frameFrom(line: string): CrashFrame | undefined {
  const match = frameLine.exec(line)
  if (!match) return undefined
  const fn = match[1]
  const location = match[2] ?? match[3] ?? ''
  const position = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(location)
  const found = position?.[1] ?? location
  const filename = kept(found) ? found : '<path>'
  const lineno = position?.[2]
  const colno = position?.[3]
  return {
    ...(fn !== undefined && { function: fn }),
    filename,
    ...(lineno !== undefined && { lineno: Number(lineno) }),
    ...(colno !== undefined && { colno: Number(colno) }),
    in_app: filename.startsWith('packages/'),
  }
}

export function cleanCrash(crash: Crash, roots: readonly string[], home: string): CleanCrash {
  const message = [...cleanText(crash.message, roots, home)].slice(0, maxCrashMessage).join('')
  const frames = (crash.stack === undefined ? [] : cleanText(crash.stack, roots, home).split('\n'))
    .map(frameFrom)
    .filter((frame) => frame !== undefined)
    .slice(0, maxCrashFrames)
  return { type: cleanText(crash.type, roots, home).slice(0, maxCrashType), message, frames }
}

export function crashEnvelope(
  clean: CleanCrash,
  crash: Pick<Crash, 'source'>,
  context: {
    eventId: string
    sentAt: Date
    dsn: string
    part: CrashPart
    edition: Edition
    version: string
  },
): Uint8Array<ArrayBuffer> {
  const { eventId, sentAt, dsn, part, edition, version } = context
  const exception = {
    type: clean.type,
    value: clean.message,
    mechanism: { type: crash.source, handled: false },
    ...(clean.frames.length > 0 && { stacktrace: { frames: [...clean.frames].reverse() } }),
  }
  const event = {
    event_id: eventId,
    timestamp: sentAt.getTime() / 1000,
    platform: 'node',
    level: 'error',
    environment: edition,
    release: version,
    tags: { part },
    contexts: { os: { name: os.type(), version: os.release() } },
    exception: { values: [exception] },
  }
  const head = [
    { event_id: eventId, sent_at: sentAt.toISOString(), dsn, sdk: { name: 'ted', version } },
    { type: 'event' },
    event,
  ]
  return new Uint8Array(
    Buffer.from(`${head.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8'),
  )
}

export function crashReporter(options: CrashReporterOptions): ReportCrash {
  const roots = options.codeRoots ?? [tedCodeRoot]
  const home = options.home ?? os.homedir()
  const now = options.now ?? (() => new Date())
  const seen = new Set<string>()
  let sent: number[] = []

  return async (crash) => {
    try {
      if (!options.enabled()) return
      const target = sentryTarget(options.dsn, { allowLoopbackHttp: options.allowLoopbackHttp })
      if (!target) return
      const clean = cleanCrash(crash, roots, home)
      const top = clean.frames[0]
      const key = JSON.stringify([clean.type, clean.message, top?.filename, top?.lineno])
      if (seen.has(key)) return
      const sentAt = now()
      sent = sent.filter((at) => sentAt.getTime() - at < hourMs)
      if (sent.length >= crashesPerHour) return
      seen.add(key)
      sent.push(sentAt.getTime())
      const body = crashEnvelope(clean, crash, {
        eventId: newEventId(),
        sentAt,
        dsn: options.dsn,
        part: options.part,
        edition: options.edition,
        version: options.version,
      })
      await options.post(
        target.url,
        envelopeRequest(target, options.version, body, options.timeoutMs ?? 5000),
      )
    } catch {}
  }
}
