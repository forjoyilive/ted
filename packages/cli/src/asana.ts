import { stripVTControlCharacters } from 'node:util'
import type { AsanaImportPreview, AsanaImportResult, AsanaImportRow } from '@ted/protocol'

function printable(text: string): string {
  return [...stripVTControlCharacters(text)]
    .filter((c) => {
      const code = c.codePointAt(0) ?? 0
      return !((code < 0x20 && c !== '\t' && c !== '\n') || (code >= 0x7f && code <= 0x9f))
    })
    .join('')
}

function actionText(row: AsanaImportRow): string {
  const action = row.action
  switch (action.kind) {
    case 'new':
      return row.completed ? 'new · complete in Asana' : 'new'
    case 'kept':
      return `${action.displayId} · unchanged`
    case 'linked':
      return `${action.displayId} · moves under its parent`
    case 'done':
      return `${action.displayId} · Done`
    case 'complete':
      return 'complete · context'
    case 'archived':
      return `${action.displayId} · archived, left alone`
    case 'conflict':
      return `${action.displayId} · under ${action.parentDisplayId}, left there`
    case 'unreadable':
      return `can’t read (${action.reason})`
  }
}

export function asanaTreeText(preview: AsanaImportPreview): string {
  const rows = preview.rows.map((row) => {
    const name = `${'  '.repeat(row.depth)}${row.name}`
    const who = row.assignee ? (row.assignee.you ? 'you' : row.assignee.name) : 'unassigned'
    return [name, who, actionText(row)].map((cell) => printable(cell))
  })
  const width = (index: number) => Math.min(48, Math.max(...rows.map((r) => r[index]?.length ?? 0)))
  const lines = rows.map(([name = '', who = '', what = '']) =>
    [name.padEnd(width(0)), who.padEnd(width(1)), what].join('  ').trimEnd(),
  )
  const problems = preview.rows.flatMap((row) =>
    (row.problems ?? []).map((problem) => printable(`${row.name}: ${problem}`)),
  )
  return [
    ...lines,
    ...problems,
    ...(preview.missing > 0
      ? [
          `${preview.missing} ${preview.missing === 1 ? 'item needs' : 'items need'} your answer after import; the Task above ${preview.missing === 1 ? 'it' : 'them'} won’t start until you answer.`,
        ]
      : []),
  ].join('\n')
}

export function asanaImportedText(result: AsanaImportResult): string {
  const root = result.root?.displayId ?? 'the tree'
  const created =
    result.created.length === 0
      ? `Created no new Tasks under ${root}`
      : `Created ${result.created.length} ${result.created.length === 1 ? 'Task' : 'Tasks'} (${result.created.map((t) => t.displayId).join(', ')})`
  const linked =
    result.linked.length === 0
      ? ''
      : `; ${result.linked.map((t) => t.displayId).join(', ')} moved under ${result.linked.length === 1 ? 'its' : 'their'} new parent`
  const waiting =
    result.preview.missing > 0
      ? `\nTED waits for your answer about ${result.preview.missing} ${result.preview.missing === 1 ? 'item' : 'items'} that didn’t come across.`
      : ''
  return `${created}${linked}.${waiting}`
}
