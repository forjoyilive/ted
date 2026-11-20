import type { Factory, Priority, Task } from '@ted/protocol'
import { phoneNewTaskPriority, RequestValidationError } from '@ted/protocol'
import { RequestError } from '../errors.ts'
import { redactSecrets } from '../redact.ts'
import type { Caller } from '../tasks/tasks.ts'
import type { PhoneOutcome } from './requests.ts'
import { type PhoneTasks, phoneIcon } from './tasks.ts'

type PhoneCaller = Extract<Caller, { kind: 'phone' }>

export const phoneStartRefusedMax = 500

export interface PhoneNewTaskInput {
  createId: string
  factory: string
  title?: string
  description?: string
  priority: Priority
  start: boolean
}

export interface PhoneTaskCreation {
  factories(): readonly Pick<Factory, 'key' | 'name' | 'icon' | 'position'>[]
  task(ref: string): Task | undefined
  create(
    input: { factory: string; title: string; description: string; priority: Priority },
    caller: PhoneCaller,
  ): Promise<Task>
  start(ref: string): Promise<Task>
}

export interface PhoneCreatedTasks {
  createdTask(phoneId: string, createId: string): string | undefined
  markTaskCreated(input: { phoneId: string; createId: string; taskId: string; at: string }): void
  persisted(): Promise<void>
}

export interface PhoneNewTask {
  factories(): PhoneOutcome
  create(caller: PhoneCaller, input: PhoneNewTaskInput): Promise<PhoneOutcome>
}

export function createPhoneNewTask(
  changes: PhoneTaskCreation,
  created: PhoneCreatedTasks,
  tasks: PhoneTasks,
  now: () => number,
): PhoneNewTask {
  const running = new Map<string, Promise<PhoneOutcome>>()

  async function shown(taskId: string, startRefused?: string): Promise<PhoneOutcome> {
    const outcome = await tasks.read(taskId)
    if (startRefused === undefined || !('body' in outcome) || !('task' in outcome.body)) {
      return outcome
    }
    return { body: { ...outcome.body, startRefused } }
  }

  async function make(caller: PhoneCaller, input: PhoneNewTaskInput): Promise<PhoneOutcome> {
    const earlier = created.createdTask(caller.phoneId, input.createId)
    if (earlier !== undefined) {
      const task = changes.task(earlier)
      return task && !task.archived ? shown(task.id) : { code: 'gone' }
    }
    const title = input.title?.trim() ?? ''
    if (title === '') return { code: 'refused', message: 'A Task needs a title.' }
    let task: Task
    try {
      task = await changes.create(
        {
          factory: input.factory,
          title,
          description: input.description ?? '',
          priority: input.priority,
        },
        caller,
      )
    } catch (error) {
      const message =
        error instanceof RequestError || error instanceof RequestValidationError
          ? redactSecrets(error.message)
          : undefined
      if (message !== undefined) return { code: 'refused', message }
      console.error(redactSecrets(`a phone couldn’t create a Task: ${String(error)}`))
      return { code: 'refused' }
    }
    created.markTaskCreated({
      phoneId: caller.phoneId,
      createId: input.createId,
      taskId: task.id,
      at: new Date(now()).toISOString(),
    })
    await created.persisted()
    if (!input.start) return shown(task.id)
    try {
      await changes.start(task.id)
    } catch (error) {
      const message =
        error instanceof RequestError || error instanceof RequestValidationError
          ? redactSecrets(error.message)
          : undefined
      if (message === undefined) {
        console.error(redactSecrets(`a phone couldn’t start ${task.displayId}: ${String(error)}`))
      }
      return shown(task.id, (message ?? 'Ted couldn’t start it.').slice(0, phoneStartRefusedMax))
    }
    return shown(task.id)
  }

  return {
    factories: () => ({
      body: {
        factories: [...changes.factories()]
          .sort((a, b) => a.position - b.position)
          .map((factory) => {
            const icon = phoneIcon(factory.icon)
            return {
              key: factory.key,
              name: redactSecrets(factory.name),
              ...(icon !== undefined && { icon }),
              defaultPriority: phoneNewTaskPriority,
            }
          }),
      },
    }),
    create(caller, input) {
      const key = JSON.stringify([caller.phoneId, input.createId])
      const pending = running.get(key)
      if (pending) return pending
      const work = make(caller, input).finally(() => running.delete(key))
      running.set(key, work)
      return work
    },
  }
}
