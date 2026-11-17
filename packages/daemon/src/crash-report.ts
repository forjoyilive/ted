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
  String.raw`${boundary}([^\s'"\x60()<>,;/\\]*[/\\][^\s'"\x60()<>,;]*)`,
  'gm',
)
const betweenPaths = /<path>(?:[ \t]+\S+)*[ \t]+<path>/g
const keptPrefixes = ['packages/', 'node:', '<path>', '<anonymous>']

const openingQuote = /["\x60]|(?<!\w)'/
const pathLike = /^(?:<path>|file:\/\/|~?\/|[A-Za-z]:\\)/

function withoutQuotedLine(line: string): string {
  const opening = openingQuote.exec(line)
  if (!opening) return line
  const quote = line.charAt(opening.index)
  const placeholder = pathLike.test(line.slice(opening.index + 1)) ? '<path>' : '<text>'
  return `${line.slice(0, opening.index)}${quote}${placeholder}${quote}`
}

function withoutQuotedText(text: string): string {
  return text.split('\n').map(withoutQuotedLine).join('\n')
}

function kept(token: string): boolean {
  return keptPrefixes.some((prefix) => token.startsWith(prefix))
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

function withoutTrailingSlashes(text: string): string {
  let end = text.length
  while (end > 0 && (text.charAt(end - 1) === '/' || text.charAt(end - 1) === '\\')) end--
  return text.slice(0, end)
}

function rootForms(root: string): string[] {
  const trimmed = withoutTrailingSlashes(root)
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

const digits = /^\d+$/

interface FrameParts {
  fn?: string
  location: string
}

function frameParts(line: string): FrameParts | undefined {
  const trimmed = line.trimStart()
  if (!trimmed.startsWith('at ')) return undefined
  const rest = trimmed.slice(3)
  if (rest === '') return undefined
  const open = rest.indexOf(' (')
  if (open > 0 && rest.endsWith(')') && rest.length > open + 3) {
    return { fn: rest.slice(0, open), location: rest.slice(open + 2, -1) }
  }
  return { location: rest }
}

function positionParts(location: string) {
  let file = location
  const numbers: string[] = []
  while (numbers.length < 2) {
    const at = file.lastIndexOf(':')
    if (at === -1 || !digits.test(file.slice(at + 1))) break
    numbers.unshift(file.slice(at + 1))
    file = file.slice(0, at)
  }
  return { file, numbers }
}

function frameFrom(line: string): CrashFrame | undefined {
  const parts = frameParts(line)
  if (!parts) return undefined
  const { file, numbers } = positionParts(parts.location)
  const filename = kept(file) ? file : '<path>'
  const [lineno, colno] = numbers
  return {
    ...(parts.fn !== undefined && { function: parts.fn }),
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
