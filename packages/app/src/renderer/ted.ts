import type { Comment, DaemonEvent, Factory, Task } from '@ted/protocol'

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
  listComments: (taskId: string) =>
    window.ted.request('listComments', taskId) as Promise<Comment[]>,
  listFactories: () => window.ted.request('listFactories') as Promise<Factory[]>,
  setupLog: (taskId: string, repo: string) =>
    window.ted.request('setupLog', taskId, repo) as Promise<string>,
  locateLocalFolder: (key: string) =>
    window.ted.request('locateLocalFolder', key) as Promise<Factory | undefined>,
  onEvent: (listener: (event: DaemonEvent) => void) => window.ted.onEvent(listener),
}
