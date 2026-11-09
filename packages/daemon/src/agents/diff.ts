// Ported from agent-orchestrator (Apache-2.0): backend/internal/adapters/chatdriver/acp/diff_stats.go
// and codexappserver/normalize.go (countPatchLines). TED changed: TypeScript, returns the diff
// lines as well as the counts, caps their number, and reads unified patches into lines.
import type { ChatDiff, ChatDiffLine } from '@ted/protocol'

const maxLines = 400
const maxCells = 4_000_000

function splitLines(value: string): string[] {
  if (value === '') return []
  const lines = value.split('\n')
  if (value.endsWith('\n')) lines.pop()
  return lines
}

function lcsTable(a: string[], b: string[]): Uint32Array {
  const width = b.length + 1
  const table = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0)
    }
  }
  return table
}

function lineDiff(oldLines: string[], newLines: string[]): ChatDiffLine[] {
  if (oldLines.length * newLines.length > maxCells) {
    return [
      ...oldLines.map((text) => ({ kind: 'removed' as const, text })),
      ...newLines.map((text) => ({ kind: 'added' as const, text })),
    ]
  }
  const table = lcsTable(oldLines, newLines)
  const width = newLines.length + 1
  const lines: ChatDiffLine[] = []
  let i = 0
  let j = 0
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      lines.push({ kind: 'context', text: oldLines[i] ?? '' })
      i++
      j++
    } else if (
      i < oldLines.length &&
      (j === newLines.length ||
        (table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0))
    ) {
      lines.push({ kind: 'removed', text: oldLines[i] ?? '' })
      i++
    } else {
      lines.push({ kind: 'added', text: newLines[j] ?? '' })
      j++
    }
  }
  return lines
}

function finish(path: string, lines: ChatDiffLine[]): ChatDiff {
  const additions = lines.filter((l) => l.kind === 'added').length
  const deletions = lines.filter((l) => l.kind === 'removed').length
  return {
    path,
    additions,
    deletions,
    lines: lines.slice(0, maxLines),
    ...(lines.length > maxLines && { truncated: true }),
  }
}

export function diffTexts(path: string, oldText: string, newText: string): ChatDiff {
  return finish(path, lineDiff(splitLines(oldText), splitLines(newText)))
}

export function diffPatch(
  path: string,
  patch: string,
  status: 'added' | 'deleted' | 'modified',
): ChatDiff {
  if (!patch.includes('@@')) {
    const lines = splitLines(patch)
    if (status === 'added') return finish(path, lines.map((text) => ({ kind: 'added', text })))
    if (status === 'deleted') return finish(path, lines.map((text) => ({ kind: 'removed', text })))
    return finish(path, [])
  }
  const lines: ChatDiffLine[] = []
  let inHunk = false
  for (const line of splitLines(patch)) {
    if (line.startsWith('@@')) inHunk = true
    else if (!inHunk) continue
    else if (line.startsWith('+')) lines.push({ kind: 'added', text: line.slice(1) })
    else if (line.startsWith('-')) lines.push({ kind: 'removed', text: line.slice(1) })
    else if (line.startsWith(' ')) lines.push({ kind: 'context', text: line.slice(1) })
  }
  return finish(path, lines)
}
