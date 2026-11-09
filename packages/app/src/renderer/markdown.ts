export type MarkdownBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'code'; text: string }

export type MarkdownSpan =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'emphasis'; text: string }

export function markdownBlocks(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | undefined
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') })
    paragraph = []
    if (list) blocks.push({ kind: 'list', ...list })
    list = undefined
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const fence = /^\s*(```|~~~)/.exec(line)
    if (fence) {
      flush()
      const code: string[] = []
      for (i++; i < lines.length && !(lines[i] ?? '').trim().startsWith(fence[1] ?? '```'); i++) {
        code.push(lines[i] ?? '')
      }
      blocks.push({ kind: 'code', text: code.join('\n') })
      continue
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      flush()
      blocks.push({ kind: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '' })
      continue
    }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line)
    if (item) {
      const ordered = item[2] !== undefined
      if (paragraph.length > 0 || (list && list.ordered !== ordered)) flush()
      list ??= { ordered, items: [] }
      list.items.push(item[3] ?? '')
      continue
    }
    if (line.trim() === '') {
      flush()
      continue
    }
    if (list && /^\s+\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`
      continue
    }
    if (list) flush()
    paragraph.push(line.trim())
  }
  flush()
  return blocks
}

export function markdownSpans(text: string): MarkdownSpan[] {
  const spans: MarkdownSpan[] = []
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0
    if (at > last) spans.push({ kind: 'text', text: text.slice(last, at) })
    if (match[1] !== undefined) spans.push({ kind: 'code', text: match[1] })
    else if (match[2] !== undefined || match[3] !== undefined) {
      spans.push({ kind: 'strong', text: match[2] ?? match[3] ?? '' })
    } else spans.push({ kind: 'emphasis', text: match[4] ?? match[5] ?? '' })
    last = at + match[0].length
  }
  if (last < text.length) spans.push({ kind: 'text', text: text.slice(last) })
  return spans
}
