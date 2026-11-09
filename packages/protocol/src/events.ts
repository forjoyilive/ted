import type { Comment, Task } from './task.ts'

export type DaemonEvent =
  | { type: 'task-created'; task: Task }
  | { type: 'task-updated'; task: Task }
  | { type: 'comment-posted'; comment: Comment }
