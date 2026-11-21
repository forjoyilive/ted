import type {
  Attachment,
  ClarifyDepth,
  Factory,
  PhoneFactory,
  Priority,
  Task,
  TaskDefaults,
  TaskLead,
} from '@ted/protocol'
import {
  phoneFileMissing,
  phoneLabelMax,
  phoneNewTaskPriority,
  phoneReplyBodyMax,
  RequestValidationError,
} from '@ted/protocol'
import { AlreadyStartedError, RequestError } from '../errors.ts'
import { redactSecrets } from '../redact.ts'
import type { Caller } from '../tasks/tasks.ts'
import { cutChars, jsonBytes } from './fit.ts'
import { phoneFactoryIcons, phoneFactoryImage } from './icons.ts'
import type { PhoneOutcome } from './requests.ts'
import type { PhoneTasks } from './tasks.ts'
import { consumeSent, type PhoneFiles } from './uploads.ts'

type PhoneCaller = Extract<Caller, { kind: 'phone' }>

export const phoneStartRefusedMax = 500

export interface PhoneNewTaskInput {
  createId: string
  factory: string
  title?: string
  description?: string
  priority: Priority
  start: boolean
  files?: readonly string[]
}

export interface PhoneTaskCreation {
  factories(): readonly Pick<Factory, 'id' | 'key' | 'name' | 'icon' | 'position' | 'createdAt'>[]
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
      attachments?: Attachment[]
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
  factoryImage(factoryId: string): PhoneOutcome
  create(caller: PhoneCaller, input: PhoneNewTaskInput): Promise<PhoneOutcome>
}

export function createPhoneNewTask(
  changes: PhoneTaskCreation,
  created: PhoneCreatedTasks,
  tasks: PhoneTasks,
  files: PhoneFiles,
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
      const attachments = input.files ? await files.attach(caller.phoneId, input.files) : []
      if (!attachments) return { code: 'refused', message: phoneFileMissing }
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
          ...(attachments.length > 0 && { attachments }),
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
    if (input.files) await consumeSent(files, caller.phoneId, input.files)
    if (!input.start) return shown(task.id)
    try {
      await changes.start(task.id)
    } catch (error) {
      if (error instanceof AlreadyStartedError) return shown(task.id)
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
      const all = changes.factories()
      const icons = phoneFactoryIcons(all)
      const ordered = [...all].sort(
        (a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt),
      )
      for (const factory of ordered) {
        const icon = icons.get(factory.id)
        const entry: PhoneFactory = {
          id: factory.id,
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
    factoryImage(factoryId) {
      return phoneFactoryImage(changes.factories(), factoryId)
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
