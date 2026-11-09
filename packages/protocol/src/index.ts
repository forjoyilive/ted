export {
  DaemonClient,
  DaemonRequestError,
  DaemonUnreachableError,
  type Subscription,
} from './client.ts'
export { type DaemonInfo, readDaemonInfo } from './daemon-info.ts'
export type { DaemonEvent } from './events.ts'
export { tedHome, tedPaths } from './paths.ts'
export type { CreateTaskRequest, Task } from './task.ts'
export { tedVersion } from './version.ts'
