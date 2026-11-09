import type { DaemonEvent, Task } from '@ted/protocol'

export interface TedBridge {
  request(name: string, ...args: unknown[]): Promise<unknown>
  onEvent(listener: (event: DaemonEvent) => void): () => void
}

declare global {
  interface Window {
    ted: TedBridge
  }
}

export const ted = {
  listTasks: () => window.ted.request('listTasks') as Promise<Task[]>,
  onEvent: (listener: (event: DaemonEvent) => void) => window.ted.onEvent(listener),
}
