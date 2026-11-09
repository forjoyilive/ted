export interface Factory {
  id: string
  key: string
  name: string
  repo: string
  defaultBranch: string
  localFolder?: { path: string; found: boolean }
  createdAt: string
}

export interface AddFactoryRequest {
  repo: string
  key: string
  localFolder?: string
}

export interface SetLocalFolderRequest {
  path: string
}
