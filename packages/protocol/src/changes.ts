export interface ChangeFile {
  path: string
  added: number
  removed: number
  uncommitted: boolean
  committed?: { added: number; removed: number }
  binary?: true
}

export interface RepoChanges {
  name: string
  baseBranch: string
  head?: string
  mergeBase?: string
  added: number
  removed: number
  files: ChangeFile[]
  unavailable?: string
}

export interface TaskChanges {
  taskId: string
  files: number
  repos: RepoChanges[]
}

export type DiffRowKind = 'context' | 'added' | 'removed'

export interface DiffRow {
  kind: DiffRowKind
  text: string
  old?: number
  new?: number
}

export interface DiffHunk {
  header: string
  rows: DiffRow[]
}

export interface FileDiff {
  repo: string
  path: string
  head: string
  mergeBase: string
  added: number
  removed: number
  uncommitted: boolean
  committed?: { added: number; removed: number }
  binary?: true
  hunks: DiffHunk[]
  committedHunks?: DiffHunk[]
  truncated?: true
}

export function changeKey(repo: string, path: string): string {
  return `${repo}\0${path}`
}

export type LineSide = 'new' | 'old'

export interface LineAnchor {
  old?: number
  new?: number
}

export interface LineComment {
  id: string
  taskId: string
  repo: string
  path: string
  side: LineSide
  start: number
  end: number
  commit: string
  quoted: DiffRow[]
  body: string
  createdAt: string
  editedAt?: string
  sent?: { commentId: string; at: string }
  outdated?: true
}

export interface DraftLineCommentRequest {
  repo: string
  path: string
  from: LineAnchor
  to?: LineAnchor
  body: string
}

export interface EditLineCommentRequest {
  body: string
}

export function lineLabel({ start, end }: Pick<LineComment, 'start' | 'end'>): string {
  return start === end ? `line ${start}` : `lines ${start}–${end}`
}
