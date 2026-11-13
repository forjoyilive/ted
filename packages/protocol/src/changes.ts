export interface ChangeFile {
  path: string
  added: number
  removed: number
  uncommitted: boolean
  committed?: { added: number; removed: number }
  binary?: true
  previousPath?: string
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

export type ChangesSource = 'local' | 'pull-request'

export interface PullRequestChanges {
  repo: RepoChanges
  number: number
  state: string
  head: string
  base: string
  loadedAt: string
  diffs: FileDiff[]
  limited?: true
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
  unavailable?: string
}

export interface TaskCommit {
  id: string
  repo: string
  commit: string
}

export interface CommitChanges {
  repo: string
  commit: string
  subject: string
  author: string
  date: string
  parent?: string
  merge?: true
  files: ChangeFile[]
  diffs: FileDiff[]
  limited?: true
}

export const maxCommitLookups = 50

export const isCommitId = (value: string): boolean => /^[0-9a-f]{7,40}$/.test(value)

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
