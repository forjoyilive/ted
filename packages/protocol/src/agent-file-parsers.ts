import {
  type AgentCommand,
  type AgentFileChange,
  type AgentSettingsInput,
  agentPowers,
  isAgentDescription,
  isAgentId,
  isCommandRepoName,
  maxAgentCommandLength,
  maxAgentCommands,
  maxAgentDescription,
  maxAgentName,
  runCommandsNeedsReadCode,
} from './agent-files.ts'
import { maxOutsideCommands, outsideCommandWords } from './outside-command.ts'
import {
  isArray,
  isOneOf,
  isString,
  type JsonArray,
  type JsonObject,
  reader,
  type Untyped,
} from './parse.ts'
import { agentKinds } from './run.ts'
import { isModelName } from './task.ts'
import { RequestValidationError as HttpError } from './validation.ts'

const maxAgentChanges = 100
const maxInstructionChars = 256 * 1024

function fail(message: string): never {
  throw new HttpError(400, message)
}
const read = reader(fail)

function agentId(body: JsonObject, field: string): string {
  const id = read.string(body, field, 'an Agent id must be text')
  if (!isAgentId(id)) {
    fail(`\`${id}\` isn’t an Agent id; use lowercase letters, digits and hyphens`)
  }
  return id
}

function settingsInput(value: Untyped, id: string): AgentSettingsInput {
  const body = read.object(value, `${id}.settings`)
  const settings: AgentSettingsInput = {}
  const name = read.optional(body, 'name', (object, field) =>
    read.string(object, field, `${id}.name must be text`).trim(),
  )
  if (name !== undefined) {
    if (name === '' || name.length > maxAgentName) {
      fail(`${id}.name must be text of up to ${maxAgentName} characters`)
    }
    settings.name = name
  }
  const description = read.optional(body, 'description', (object, field) =>
    read.string(object, field, `${id}.description must be text`).trim(),
  )
  if (description !== undefined && description !== '') {
    if (!isAgentDescription(description)) {
      fail(`${id}.description must be one line of text of up to ${maxAgentDescription} characters`)
    }
    settings.description = description
  }
  const agent = read.optional(body, 'agent', (object, field) =>
    read.oneOf(object, field, agentKinds, `${id}.agent must be ${agentKinds.join(', ')}`),
  )
  if (agent !== undefined) settings.agent = agent
  const model = read.optional(body, 'model', (object, field) =>
    read.string(object, field, `${id}.model must be a model name`).trim(),
  )
  if (model !== undefined && model !== '') {
    if (!isModelName(model)) fail(`${id}.model must be a model name`)
    settings.model = model
  }
  const powers = read.optional(body, 'powers', (object, field) =>
    read.list(object, field, `${id}.powers must be a list`),
  )
  if (powers !== undefined) {
    settings.powers = agentPowers.filter((power) => powers.includes(power))
    const stray = powers.find((power) => !isOneOf(power, agentPowers))
    if (stray !== undefined) fail(`${id}.powers has an unknown power: ${String(stray)}`)
    if (settings.powers.includes('run_commands') && !settings.powers.includes('read_code'))
      fail(`${id}: ${runCommandsNeedsReadCode}`)
  }
  const commands = read.optional(body, 'commands', (object, field) =>
    read.list(object, field, `${id}.commands must be a list`),
  )
  if (commands !== undefined) settings.commands = commandsInput(commands, id)
  const outside = read.optional(body, 'outsideCommands', (object, field) =>
    read.list(object, field, `${id}.outsideCommands must be a list`),
  )
  if (outside !== undefined) settings.outsideCommands = commandsInput(outside, id, true)
  return settings
}

function commandsInput(items: JsonArray, id: string, outside = false): AgentCommand[] {
  const most = outside ? maxOutsideCommands : maxAgentCommands
  const what = outside ? 'outside commands' : 'commands'
  if (items.length > most) fail(`${id} has more than ${most} ${what}`)
  const seen = new Set<string>()
  return items.map((item) => {
    const body = read.object(item, `a command of ${id}`)
    const name = read.string(body, 'name', `${id}: a command’s name must be text`).trim()
    if (!isAgentId(name))
      fail(`${id}: \`${name}\` isn’t a command name; use lowercase letters, digits and hyphens`)
    if (seen.has(name)) fail(`${id} lists the command ${name} twice`)
    seen.add(name)
    const command = read.string(body, 'command', `${id}.${name} must be a command`).trim()
    if (command === '' || command.length > maxAgentCommandLength)
      fail(`${id}.${name} must be a command of up to ${maxAgentCommandLength} characters`)
    if (outside) {
      const words = outsideCommandWords(command)
      if ('problem' in words) fail(`${id}: the outside command ${name} ${words.problem}`)
    }
    const repo = read.optional(body, 'repo', (object, field) =>
      read.string(object, field, `${id}.${name}.repo must be a repo name`),
    )
    if (repo !== undefined && !isCommandRepoName(repo))
      fail(`${id}.${name}.repo must be a repo name`)
    return { name, command, ...(repo !== undefined && { repo }) }
  })
}

function instructions(body: JsonObject, id: string): string | null {
  const value = body.instructions
  if (value === null) return null
  if (!isString(value)) fail(`${id}.instructions must be text or null`)
  if (value.length > maxInstructionChars) fail(`${id}.instructions is too long`)
  return value
}

export function parseAgentFileChanges(value: Untyped): AgentFileChange[] {
  if (!isArray(value)) fail('agentFiles must be a list')
  if (value.length > maxAgentChanges) fail('agentFiles is too long')
  const seen = new Set<string>()
  return value.map((item) => {
    const body = read.object(item, 'an agentFiles entry')
    const id = agentId(body, 'id')
    if (seen.has(id)) fail(`agentFiles lists ${id} twice`)
    seen.add(id)
    const change: AgentFileChange = { id }
    if (body.settings === null) change.settings = null
    else if (body.settings !== undefined) change.settings = settingsInput(body.settings, id)
    if (body.instructions !== undefined) change.instructions = instructions(body, id)
    return change
  })
}

export function parseKeepAgentFiles(value: Untyped): string[] {
  if (!isArray(value)) fail('keepAgentFiles must be a list')
  if (value.length > maxAgentChanges) fail('keepAgentFiles is too long')
  return value.map((id) => {
    if (!isString(id) || !isAgentId(id)) fail(`\`${String(id)}\` isn’t an Agent id`)
    return id
  })
}
