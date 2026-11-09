export interface Task {
  id: string
  factoryId: string
  number: number
  displayId: string
  title: string
  createdAt: string
}

export interface CreateTaskRequest {
  title: string
}
