import type {
  ClarifyDepth,
  Factory,
  PhoneFactory,
  Priority,
  Task,
  TaskDefaults,
  TaskLead,
} from '@ted/protocol'
import {
  phoneLabelMax,
  phoneNewTaskPriority,
  phoneReplyBodyMax,
  RequestValidationError,
} from '@ted/protocol'
import { RequestError } from '../errors.ts'
import { redactSecrets } from '../redact.ts'
import type { Caller } from '../tasks/tasks.ts'
import { cutChars, jsonBytes } from './fit.ts'
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
  factories(): readonly Pick<Factory, 'id' | 'key' | 'name' | 'icon' | 'position'>[]
  defaults(factoryId: string): Promise<TaskDefaults>
  task(ref: string): Task | undefined
  create(
    input: {
      factory: string
      title: string
      description: string
      priority: Priority
      lead: TaskLead
      clarifyDepth: ClarifyDepth
      phoneCreate: { phoneId: string; createId: string }
    },
    caller: PhoneCaller,
  ): Promise<Task>
  start(ref: string): Promise<Task>
}

export interface PhoneCreatedTasks {
  createdTask(phoneId: string, createId: string): string | undefined
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
    const factory = changes.factories().find((each) => each.key === input.factory)
    if (!factory) {
      return { code: 'refused', message: redactSecrets(`no Factory with key ${input.factory}`) }
    }
    let task: Task
    try {
      const defaults = await changes.defaults(factory.id)
      task = await changes.create(
        {
          factory: factory.key,
          title,
          description: input.description ?? '',
          priority: input.priority,
          lead: defaults.lead,
          clarifyDepth: defaults.clarifyDepth,
          phoneCreate: { phoneId: caller.phoneId, createId: input.createId },
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
    factories() {
      const factories: PhoneFactory[] = []
      for (const factory of [...changes.factories()].sort((a, b) => a.position - b.position)) {
        const icon = phoneIcon(factory.icon)
        const entry: PhoneFactory = {
          key: factory.key,
          name: cutChars(redactSecrets(factory.name), phoneLabelMax),
          ...(icon !== undefined && { icon }),
          defaultPriority: phoneNewTaskPriority,
        }
        if (jsonBytes({ factories: [...factories, entry] }) > phoneReplyBodyMax) break
        factories.push(entry)
      }
      return { body: { factories } }
    },
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
