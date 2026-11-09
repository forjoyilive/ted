export interface Factory {
  id: string
  key: string
  name: string
  repo: string
  defaultBranch: string
  createdAt: string
}

export interface AddFactoryRequest {
  repo: string
  key: string
}
