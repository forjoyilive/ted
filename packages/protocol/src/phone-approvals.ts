import type { ConfirmationChoices, CoordinatorConfirmationAnswer } from './coordinator.ts'
import { parseCoordinatorConfirmationAnswer } from './coordinator-parsers.ts'
import { type JsonObject, reader, type Untyped } from './parse.ts'

export interface PhoneApprovalTask {
  id: string
  label: string
  working: boolean
  descendants: string[]
  blocked: string[]
  blockedTogether: string[]
  pullRequests: string[]
  children?: ConfirmationChoices['children']
  closePullRequests?: boolean
  result?: string
}

export type PhoneApproval =
  | {
      kind: 'confirmation'
      operation: 'archive' | 'delete' | 'transfer'
      chatId: string
      title: string
      tasks: PhoneApprovalTask[]
      warnings: string[]
      decision?: 'confirm' | 'cancel'
      refusal?: string
      revision?: string
    }
  | {
      kind: 'outside-command'
      chatId: string
      title: string
      command: string
      argument?: string
      repo: string
      folder: string
      warnings: string[]
      runLabel: string
      canAlways: boolean
      revision: string
      result?: string
    }

export type PhoneApprovalAnswer =
  | ({ action: 'confirm-tasks'; chatId: string; revision?: string } & CoordinatorConfirmationAnswer)
  | {
      action: 'approve-command'
      chatId: string
      decision: 'run' | 'always' | 'decline'
      revision: string
    }
  | { action: 'stop-command'; chatId: string }

const read = reader()
const strings = (value: JsonObject, field: string) =>
  read.list(value, field).map((each) => read.string({ each }, 'each'))

export function parsePhoneApproval(value: Untyped): PhoneApproval {
  const object = read.object(value, 'approval')
  const kind = read.oneOf(object, 'kind', ['confirmation', 'outside-command'])
  const chatId = read.string(object, 'chatId')
  const title = read.string(object, 'title')
  const warnings = strings(object, 'warnings')
  if (kind === 'outside-command') {
    const argument = read.optional(object, 'argument', read.string)
    const result = read.optional(object, 'result', read.string)
    return {
      kind,
      chatId,
      title,
      warnings,
      command: read.string(object, 'command'),
      repo: read.string(object, 'repo'),
      folder: read.string(object, 'folder'),
      runLabel: read.string(object, 'runLabel'),
      canAlways: read.boolean(object, 'canAlways'),
      revision: read.string(object, 'revision'),
      ...(argument !== undefined && { argument }),
      ...(result !== undefined && { result }),
    }
  }
  const decision = read.optional(object, 'decision', (o, f) =>
    read.oneOf(o, f, ['confirm', 'cancel']),
  )
  const refusal = read.optional(object, 'refusal', read.string)
  const revision = read.optional(object, 'revision', read.string)
  return {
    kind,
    chatId,
    title,
    warnings,
    operation: read.oneOf(object, 'operation', ['archive', 'delete', 'transfer']),
    tasks: read.list(object, 'tasks').map((each): PhoneApprovalTask => {
      const task = read.object(each, 'Task')
      const children = read.optional(task, 'children', (o, f) =>
        read.oneOf(o, f, ['archive', 'detach', 'delete', 'unparent']),
      )
      const closePullRequests = read.optional(task, 'closePullRequests', read.boolean)
      const result = read.optional(task, 'result', read.string)
      return {
        id: read.string(task, 'id'),
        label: read.string(task, 'label'),
        working: read.boolean(task, 'working'),
        descendants: strings(task, 'descendants'),
        blocked: strings(task, 'blocked'),
        blockedTogether: strings(task, 'blockedTogether'),
        pullRequests: strings(task, 'pullRequests'),
        ...(children !== undefined && { children }),
        ...(closePullRequests !== undefined && { closePullRequests }),
        ...(result !== undefined && { result }),
      }
    }),
    ...(decision !== undefined && { decision }),
    ...(refusal !== undefined && { refusal }),
    ...(revision !== undefined && { revision }),
  }
}

export function parsePhoneApprovalAnswer(
  object: JsonObject,
  action: PhoneApprovalAnswer['action'],
): PhoneApprovalAnswer {
  const chatId = read.string(object, 'chatId')
  if (action === 'stop-command') return { action, chatId }
  if (action === 'approve-command') {
    return {
      action,
      chatId,
      decision: read.oneOf(object, 'decision', ['run', 'always', 'decline']),
      revision: read.string(object, 'revision'),
    }
  }
  const revision = read.optional(object, 'revision', read.string)
  return {
    action,
    chatId,
    ...parseCoordinatorConfirmationAnswer(object),
    ...(revision !== undefined && { revision }),
  }
}
