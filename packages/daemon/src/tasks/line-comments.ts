import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  DiffRow,
  DraftLineCommentRequest,
  FileDiff,
  LineAnchor,
  LineComment,
  LineSide,
} from '@ted/protocol'
import { RequestError } from '../errors.ts'
import { type ChangesTarget, fileDiffs } from './changes.ts'

export const maxLineCommentLength = 20_000
const maxQuotedRows = 200

export interface Anchored {
  side: LineSide
  start: number
  end: number
  quoted: DiffRow[]
}

const matches = (row: DiffRow, anchor: LineAnchor) =>
  (anchor.new !== undefined || anchor.old !== undefined) &&
  (anchor.new === undefined || row.new === anchor.new) &&
  (anchor.old === undefined || row.old === anchor.old)

export function anchorIn(diff: FileDiff, from: LineAnchor, to: LineAnchor = from): Anchored {
  for (const hunk of diff.hunks) {
    const first = hunk.rows.findIndex((row) => matches(row, from))
    if (first < 0) continue
    const last = hunk.rows.findIndex((row, i) => i >= first && matches(row, to))
    if (last < 0) {
      throw new RequestError(400, 'a line comment’s range has to stay inside one hunk')
    }
    const quoted = hunk.rows.slice(first, last + 1)
    if (quoted.length > maxQuotedRows) {
      throw new RequestError(400, `a line comment covers at most ${maxQuotedRows} lines`)
    }
    const side: LineSide = quoted.some((r) => r.new !== undefined) ? 'new' : 'old'
    const numbers = quoted.flatMap((r) => r[side] ?? [])
    return {
      side,
      start: Math.min(...numbers),
      end: Math.max(...numbers),
      quoted,
    }
  }
  throw new RequestError(409, 'that line isn’t in the diff any more')
}

export function draftRequest(body: unknown): DraftLineCommentRequest {
  const request = (body ?? {}) as Partial<DraftLineCommentRequest>
  const text = typeof request.body === 'string' ? request.body.trim() : ''
  if (typeof request.repo !== 'string' || request.repo === '') {
    throw new RequestError(400, 'repo is required')
  }
  if (typeof request.path !== 'string' || request.path === '') {
    throw new RequestError(400, 'path is required')
  }
  const from = anchor(request.from, 'from')
  const to = request.to === undefined ? undefined : anchor(request.to, 'to')
  return { repo: request.repo, path: request.path, from, ...(to && { to }), body: lineText(text) }
}

export function lineText(text: unknown): string {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed === '') throw new RequestError(400, 'a line comment needs some text')
  if (trimmed.length > maxLineCommentLength) {
    throw new RequestError(400, `a line comment is limited to ${maxLineCommentLength} characters`)
  }
  return trimmed
}

function anchor(value: unknown, name: string): LineAnchor {
  const given = (value ?? {}) as Record<string, unknown>
  const line = (key: 'old' | 'new') => {
    const n = given[key]
    if (n === undefined) return undefined
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
      throw new RequestError(400, `${name}.${key} must be a line number`)
    }
    return n
  }
  const old = line('old')
  const added = line('new')
  if (old === undefined && added === undefined) {
    throw new RequestError(400, `${name} needs an old or new line number`)
  }
  return { ...(old !== undefined && { old }), ...(added !== undefined && { new: added }) }
}

export async function markOutdated(
  comments: readonly LineComment[],
  targets: readonly ChangesTarget[],
): Promise<LineComment[]> {
  const diffs = new Map<string, Promise<FileDiff | undefined>>()
  const diffOf = (target: ChangesTarget, file: string) => {
    const key = `${target.name}\0${file}`
    let found = diffs.get(key)
    if (!found) {
      found = fileDiffs(target, file).then(
        (list) => list[0],
        () => undefined,
      )
      diffs.set(key, found)
    }
    return found
  }
  return Promise.all(
    comments.map(async (comment) => {
      const target = targets.find((t) => t.name === comment.repo)
      if (!target) return comment
      const changed =
        comment.side === 'new'
          ? await newSideChanged(comment, target.worktree)
          : oldSideChanged(comment, await diffOf(target, comment.path))
      return changed ? { ...comment, outdated: true as const } : comment
    }),
  )
}

async function newSideChanged(comment: LineComment, worktree: string): Promise<boolean> {
  const file = path.join(worktree, comment.path)
  const inside = path.relative(worktree, file)
  if (inside.startsWith('..') || path.isAbsolute(inside)) return true
  const stat = await lstat(file).catch(() => undefined)
  if (!stat) return true
  if (!stat.isFile()) return false
  const lines = (await readFile(file, 'utf8')).split('\n')
  return comment.quoted.some(
    (row) => row.new !== undefined && lines[row.new - 1]?.replace(/\r$/, '') !== row.text,
  )
}

function oldSideChanged(comment: LineComment, diff: FileDiff | undefined): boolean {
  if (!diff) return true
  const rows = diff.hunks.flatMap((h) => h.rows)
  return comment.quoted.some(
    (quoted) =>
      quoted.old !== undefined &&
      !rows.some((row) => row.old === quoted.old && row.text === quoted.text),
  )
}

const marks = { context: ' ', added: '+', removed: '-' } as const

function fence(rows: readonly DiffRow[]): string {
  const longest = Math.max(
    2,
    ...rows.map((r) => Math.max(0, ...(r.text.match(/`+/g) ?? []).map((m) => m.length))),
  )
  return '`'.repeat(longest + 1)
}

export function lineCommentsText(
  comments: readonly LineComment[],
  taskId: string,
  displayIdOf: (taskId: string) => string | undefined,
): string {
  const from = comments.find((c) => c.taskId !== taskId)
  const where = from ? ` on ${displayIdOf(from.taskId) ?? 'the original Task'}’s diff` : ''
  const heading = `Line comments${where} (${comments.length}):`
  const items = comments.map((c, i) => {
    const lines = c.start === c.end ? `line ${c.start}` : `lines ${c.start}–${c.end}`
    const side = c.side === 'old' ? ' of the base version' : ''
    const ticks = fence(c.quoted)
    return [
      `${i + 1}. ${c.path} ${lines}${side}, repo ${c.repo}, commit ${c.commit}`,
      `${ticks}diff\n${c.quoted.map((r) => `${marks[r.kind]}${r.text}`).join('\n')}\n${ticks}`,
      c.body,
    ].join('\n')
  })
  return [heading, ...items].join('\n\n')
}
