export interface RepoFiles {
  repo: string
  paths: string[]
  partial: boolean
  unavailable?: string
}

export interface TaskFiles {
  taskId: string
  repos: RepoFiles[]
}

export interface TaskFileRef {
  repo: string
  path: string
}

export type TaskFileContent =
  | { kind: 'text'; text: string }
  | { kind: 'binary' | 'too-large' | 'unavailable'; message: string }

export const filePreviewLimit = 1024 * 1024
export const fileListLimit = 20_000
