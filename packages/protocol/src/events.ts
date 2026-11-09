import type { Task } from './task.ts'

export type DaemonEvent = { type: 'task-created'; task: Task }
