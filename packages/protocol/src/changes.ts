export interface ChangeFile {
  path: string
  added: number
  removed: number
  uncommitted: boolean
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
  binary?: true
  hunks: DiffHunk[]
  truncated?: true
}

export function changeKey(repo: string, path: string): string {
  return `${repo}\0${path}`
}
