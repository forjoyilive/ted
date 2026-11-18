export interface NotePiece {
  kind: 'text' | 'block'
  line: number
  text: string
}

export interface NoteParts {
  text: string
  rest: NotePiece[]
}

export function noteParts(body: string): NoteParts {
  const pieces: NotePiece[] = []
  let prose: { line: number; lines: string[] } | undefined
  let fence: { closing: RegExp; line: number; lines: string[] } | undefined
  const endProse = () => {
    const text = prose?.lines.join(' ').replace(/\s+/g, ' ').trim() ?? ''
    if (prose && text !== '') pieces.push({ kind: 'text', line: prose.line, text })
    prose = undefined
  }
  const endFence = (open: { line: number; lines: string[] }) => {
    const text = open.lines.join('\n').trimEnd()
    if (text.trim() !== '') pieces.push({ kind: 'block', line: open.line, text })
    fence = undefined
  }
  for (const [index, line] of body.split('\n').entries()) {
    if (fence) {
      if (fence.closing.test(line)) endFence(fence)
      else fence.lines.push(line)
      continue
    }
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (mark === undefined) {
      prose ??= { line: index, lines: [] }
      prose.lines.push(line)
      continue
    }
    endProse()
    fence = {
      closing: new RegExp(`^ {0,3}\\${mark.charAt(0)}{${mark.length},}\\s*$`),
      line: index,
      lines: [],
    }
  }
  if (fence) endFence(fence)
  endProse()
  const [first, ...rest] = pieces
  return first?.kind === 'text' ? { text: first.text, rest } : { text: '', rest: pieces }
}
