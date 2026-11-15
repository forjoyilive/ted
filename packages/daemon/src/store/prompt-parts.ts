import { createHash } from 'node:crypto'

export type PromptPart = { text: string } | { hash: string } | { request: string }

export const sharedTextMinLength = 256

export function promptTextHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export interface PromptSplit {
  parts: PromptPart[]
  texts: Map<string, string>
}

export function splitPrompt(
  prompt: string,
  shared: readonly string[],
  request?: { id: string; text: string },
): PromptSplit {
  const candidates = [
    ...(request && request.text.length > 0 ? [{ text: request.text, request: request.id }] : []),
    ...[...new Set(shared)]
      .filter((text) => text.length >= sharedTextMinLength)
      .sort((a, b) => b.length - a.length)
      .map((text) => ({ text, request: undefined })),
  ]
  const found: { start: number; end: number; part: PromptPart; text: string }[] = []
  for (const candidate of candidates) {
    let from = 0
    for (;;) {
      const start = prompt.indexOf(candidate.text, from)
      if (start === -1) break
      const end = start + candidate.text.length
      if (found.every((f) => end <= f.start || start >= f.end)) {
        found.push({
          start,
          end,
          text: candidate.text,
          part:
            candidate.request !== undefined
              ? { request: candidate.request }
              : { hash: promptTextHash(candidate.text) },
        })
        if (candidate.request !== undefined) break
      }
      from = end
    }
  }
  found.sort((a, b) => a.start - b.start)
  const parts: PromptPart[] = []
  const texts = new Map<string, string>()
  let at = 0
  for (const f of found) {
    if (f.start > at) parts.push({ text: prompt.slice(at, f.start) })
    parts.push(f.part)
    if ('hash' in f.part) texts.set(f.part.hash, f.text)
    at = f.end
  }
  if (at < prompt.length) parts.push({ text: prompt.slice(at) })
  const joined = joinPrompt(
    parts,
    (hash) => texts.get(hash),
    () => request?.text,
  )
  return joined === prompt ? { parts, texts } : { parts: [{ text: prompt }], texts: new Map() }
}

export function joinPrompt(
  parts: readonly PromptPart[],
  text: (hash: string) => string | undefined,
  request: (id: string) => string | undefined,
): string {
  return parts
    .map((part) =>
      'text' in part
        ? part.text
        : 'hash' in part
          ? (text(part.hash) ?? '')
          : (request(part.request) ?? ''),
    )
    .join('')
}
