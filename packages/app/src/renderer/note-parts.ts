export interface NoteBlock {
  line: number
  text: string
}

export interface NoteParts {
  text: string
  blocks: NoteBlock[]
}

export function noteParts(body: string): NoteParts {
  const prose: string[] = []
  const blocks: NoteBlock[] = []
  let fence: { closing: RegExp; line: number; lines: string[] } | undefined
  const close = (open: { line: number; lines: string[] }) => {
    const text = open.lines.join('\n').trimEnd()
    if (text.trim() !== '') blocks.push({ line: open.line, text })
    fence = undefined
  }
  for (const [index, line] of body.split('\n').entries()) {
    if (fence) {
      if (fence.closing.test(line)) close(fence)
      else fence.lines.push(line)
      continue
    }
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (mark === undefined) prose.push(line)
    else
      fence = {
        closing: new RegExp(`^ {0,3}\\${mark.charAt(0)}{${mark.length},}\\s*$`),
        line: index,
        lines: [],
      }
  }
  if (fence) close(fence)
  return { text: prose.join(' ').replace(/\s+/g, ' ').trim(), blocks }
}
