import type {
  ArchiveTaskRequest,
  Attachment,
  Comment,
  DeleteTaskRequest,
  Priority,
  Task,
} from '@ted/protocol'
import { phoneFileMissing, RequestValidationError } from '@ted/protocol'
import { AlreadyStartedError, RequestError } from '../errors.ts'
import { redactSecrets } from '../redact.ts'
import type { Caller } from '../tasks/tasks.ts'
import type { PhoneOutcome } from './requests.ts'
import type { PhoneTasks } from './tasks.ts'
import { consumeSent, type PhoneFiles } from './uploads.ts'

type PhoneCaller = Extract<Caller, { kind: 'phone' }>

export interface PhoneTaskChanges {
  task(ref: string): Task | undefined
  start(ref: string): Promise<{ waitingForBlockers: boolean }>
  stop(ref: string): Promise<Task>
  resume(ref: string, comment?: string): Promise<Task>
  setPriority(ref: string, priority: Priority): Task
  comment(
    ref: string,
    caller: PhoneCaller,
    input: { body: string; attachments?: Attachment[] },
  ): Promise<Comment>
  archive(ref: string, options: ArchiveTaskRequest): Task
  delete(ref: string, options: DeleteTaskRequest): Promise<void>
  hierarchyRevision(ref: string): string
}

export interface PhoneActions {
  start(taskId: string): Promise<PhoneOutcome>
  stop(taskId: string): Promise<PhoneOutcome>
  resume(taskId: string, text: string | undefined): Promise<PhoneOutcome>
  setPriority(taskId: string, priority: Priority): Promise<PhoneOutcome>
  comment(
    caller: PhoneCaller,
    taskId: string,
    text: string,
    files?: readonly string[],
  ): Promise<PhoneOutcome>
  archive(taskId: string, revision: string, options: PhoneArchive): Promise<PhoneOutcome>
  delete(taskId: string, revision: string, options: PhoneDelete): Promise<PhoneOutcome>
}

export type PhoneArchive = Omit<ArchiveTaskRequest, 'hierarchyRevision'>
export type PhoneDelete = Omit<DeleteTaskRequest, 'hierarchyRevision'>

export function createPhoneActions(
  changes: PhoneTaskChanges,
  tasks: PhoneTasks,
  files: PhoneFiles,
): PhoneActions {
  const visible = (taskId: string) => {
    const task = changes.task(taskId)
    return task && !task.archived ? task : undefined
  }

  function confirmed(id: string, revision: string): string {
    if (tasks.revision(id) !== revision) {
      const shown = changes.task(id)?.displayId ?? id
      throw new RequestError(
        409,
        `${shown} or its child Tasks changed since your phone read it. Open it again and choose again.`,
      )
    }
    return changes.hierarchyRevision(id)
  }

  async function act(
    taskId: string,
    change: (id: string) => Promise<{ waitingForBlockers: boolean }> | Promise<void>,
    reply: 'task' | 'empty',
  ): Promise<PhoneOutcome> {
    const task = visible(taskId)
    if (!task) return { code: 'gone' }
    try {
      const result = await change(task.id)
      return reply === 'task' ? tasks.read(task.id, result?.waitingForBlockers) : { body: {} }
    } catch (error) {
      if (error instanceof RequestError && error.status === 404 && !changes.task(task.id)) {
        return { code: 'gone' }
      }
      if (error instanceof RequestError || error instanceof RequestValidationError) {
        return { code: 'refused', message: redactSecrets(error.message) }
      }
      console.error(redactSecrets(`a phone action on ${task.displayId} failed: ${String(error)}`))
      return { code: 'refused' }
    }
  }

  return {
    start: (taskId) =>
      act(
        taskId,
        async (id) => {
          try {
            return await changes.start(id)
          } catch (error) {
            if (!(error instanceof AlreadyStartedError)) throw error
            return { waitingForBlockers: false }
          }
        },
        'task',
      ),
    stop: (taskId) =>
      act(
        taskId,
        async (id) => {
          await changes.stop(id)
        },
        'task',
      ),
    resume: (taskId, text) =>
      act(
        taskId,
        async (id) => {
          await changes.resume(id, text)
        },
        'task',
      ),
    setPriority: (taskId, priority) =>
      act(
        taskId,
        async (id) => {
          changes.setPriority(id, priority)
        },
        'task',
      ),
    comment: (caller, taskId, text, uploadIds) =>
      act(
        taskId,
        async (id) => {
          if (!uploadIds) {
            await changes.comment(id, caller, { body: text })
            return
          }
          const attachments = await files.attach(caller.phoneId, uploadIds)
          if (!attachments) throw new RequestError(409, phoneFileMissing)
          await changes.comment(id, caller, { body: text, attachments })
          await consumeSent(files, caller.phoneId, uploadIds)
        },
        'task',
      ),
    archive: (taskId, revision, options) =>
      act(
        taskId,
        async (id) => {
          changes.archive(id, { ...options, hierarchyRevision: confirmed(id, revision) })
        },
        'empty',
      ),
    delete: (taskId, revision, options) =>
      act(
        taskId,
        (id) => changes.delete(id, { ...options, hierarchyRevision: confirmed(id, revision) }),
        'empty',
      ),
  }
}
