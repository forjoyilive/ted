import type { DiffLine, FileChange } from '@ted/protocol'

const context = 2

export function fileChange(file: string, before: string, after: string): FileChange {
  const a = lines(before)
  const b = lines(after)
  const all = diffLines(a, b)
  const changed = all.map((line) => line.kind !== 'same')
  const shown: DiffLine[] = []
  let skipped = 0
  all.forEach((line, i) => {
    const near = changed.slice(Math.max(0, i - context), i + context + 1).some(Boolean)
    if (near) {
      if (skipped > 0) shown.push({ kind: 'gap', text: `${skipped} unchanged lines` })
      skipped = 0
      shown.push(line)
    } else skipped++
  })
  if (skipped > 0 && shown.length > 0) {
    shown.push({ kind: 'gap', text: `${skipped} unchanged lines` })
  }
  return {
    path: file,
    added: all.filter((l) => l.kind === 'added').length,
    removed: all.filter((l) => l.kind === 'removed').length,
    lines: shown,
  }
}

function lines(text: string): string[] {
  if (text === '') return []
  return text.replace(/\n$/, '').split('\n')
}

export function diffLines(a: string[], b: string[]): DiffLine[] {
  if (a.length * b.length > 4_000_000) {
    return [
      ...a.map((text) => ({ kind: 'removed' as const, text })),
      ...b.map((text) => ({ kind: 'added' as const, text })),
    ]
  }
  const rows = a.length + 1
  const cols = b.length + 1
  const table = new Uint32Array(rows * cols)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        a[i] === b[j]
          ? (table[(i + 1) * cols + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * cols + j] ?? 0, table[i * cols + j + 1] ?? 0)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] ?? '' })
      i++
      j++
    } else if ((table[(i + 1) * cols + j] ?? 0) >= (table[i * cols + j + 1] ?? 0)) {
      out.push({ kind: 'removed', text: a[i++] ?? '' })
    } else {
      out.push({ kind: 'added', text: b[j++] ?? '' })
    }
  }
  while (i < a.length) out.push({ kind: 'removed', text: a[i++] ?? '' })
  while (j < b.length) out.push({ kind: 'added', text: b[j++] ?? '' })
  return out
}
