import type { Comment, Task } from '@ted/protocol'
import type { Client } from '../merge-harness.ts'

export const ci = { '.github/workflows/ci.yml': 'on: pull_request\n' }

export const comments = (client: Client, task: Task) =>
  client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)
