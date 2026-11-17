import {
  type AgentCommand,
  type AgentPower,
  agentPowers,
  builtInAgentIds,
  isAgentId,
  isCommandRepoName,
  maxAgentCommandLength,
  maxAgentCommands,
  maxAgentId,
  maxAgentName,
  runCommandsNeedsReadCode,
} from './agent-files.ts'
import {
  type Fail,
  isArray,
  isOneOf,
  isString,
  type JsonArray,
  type JsonObject,
  reader,
  type Untyped,
} from './parse.ts'
import { type AgentKind, agentKinds } from './run.ts'
import { isModelName } from './task.ts'

export interface SetupAgentProposal {
  id: string
  name: string
  about: string
  powers: AgentPower[]
  commands?: AgentCommand[]
  agent?: AgentKind
  model?: string
  instructions: string
}

export const maxSetupAgents = 5

export const maxSetupAgentInstructions = 20_000

const maxAbout = 300

export function parseSetupAgents(value: Untyped, fail: Fail): SetupAgentProposal[] {
  const read = reader(fail)
  const list = isArray(value) ? value : fail('the setup proposal’s Agents must be a list', 'agents')
  if (list.length > maxSetupAgents) {
    fail(`the setup proposal suggests at most ${maxSetupAgents} Agents`, 'agents')
  }
  const seen = new Set<string>()
  return list.map((item) => {
    const row = read.object(item, 'agents', 'each of the setup proposal’s Agents must be an object')
    const id = read.string(row, 'id', 'each Agent needs an id')
    if (!isAgentId(id)) {
      fail(
        `${id} isn’t an Agent id: use lowercase letters, digits and hyphens, up to ${maxAgentId} characters`,
        'id',
      )
    }
    if (isOneOf(id, builtInAgentIds)) {
      fail(`${id} is one of Ted’s own Agents; setup can’t propose it`, 'id')
    }
    if (seen.has(id)) fail(`the setup proposal suggests ${id} twice`, 'id')
    seen.add(id)
    const name = text(row, 'name', `${id}’s name`, maxAgentName, fail)
    const about = text(row, 'about', `what ${id} is for`, maxAbout, fail)
    const powers = read.list(row, 'powers', `${id}’s powers must be a list`).map((power) => {
      if (!isOneOf(power, agentPowers)) {
        fail(`${id} asks for a power Ted doesn’t have; use ${agentPowers.join(', ')}`, 'powers')
      }
      return power
    })
    if (new Set(powers).size !== powers.length) fail(`${id} lists a power twice`, 'powers')
    if (powers.includes('run_commands') && !powers.includes('read_code')) {
      fail(`${id}: ${runCommandsNeedsReadCode}`, 'powers')
    }
    const commands = read.optional(row, 'commands', (object, field) =>
      setupCommands(read.list(object, field, `${id}’s commands must be a list`), id, fail),
    )
    if (commands !== undefined && commands.length > 0 && !powers.includes('run_commands')) {
      fail(`${id} lists commands without the run_commands power`, 'commands')
    }
    const agent = read.optional(row, 'agent', (object, field) =>
      read.oneOf(
        object,
        field,
        agentKinds,
        `${id}’s Provider must be one of ${agentKinds.join(', ')}`,
      ),
    )
    const model = read.optional(row, 'model', (object, field) => {
      const given = read.string(object, field, `${id}’s model must be text`)
      return isModelName(given) ? given : fail(`${given} isn’t a model name`, field)
    })
    if (model !== undefined && agent === undefined) {
      fail(`${id} names a model without a Provider`, 'model')
    }
    const instructions = read.string(row, 'instructions', `${id} needs its instructions text`)
    if (instructions.trim() === '') fail(`${id}’s instructions are empty`, 'instructions')
    if (instructions.length > maxSetupAgentInstructions) {
      fail(
        `${id}’s instructions are limited to ${maxSetupAgentInstructions} characters`,
        'instructions',
      )
    }
    return {
      id,
      name,
      about,
      powers: agentPowers.filter((power) => powers.includes(power)),
      ...(commands !== undefined && commands.length > 0 && { commands }),
      ...(agent !== undefined && { agent }),
      ...(model !== undefined && { model }),
      instructions,
    }
  })
}

function setupCommands(items: JsonArray, id: string, fail: Fail): AgentCommand[] {
  const read = reader(fail)
  if (items.length > maxAgentCommands) {
    fail(`${id} lists more than ${maxAgentCommands} commands`, 'commands')
  }
  const seen = new Set<string>()
  return items.map((item) => {
    const row = read.object(item, 'commands', `each of ${id}’s commands must be an object`)
    const name = read.string(row, 'name', `each of ${id}’s commands needs a name`).trim()
    if (!isAgentId(name)) {
      fail(`${name} isn’t a command name: use lowercase letters, digits and hyphens`, 'name')
    }
    if (seen.has(name)) fail(`${id} lists the command ${name} twice`, 'name')
    seen.add(name)
    const command = read.string(row, 'command', `${id}’s ${name} needs a command`).trim()
    if (command === '' || command.length > maxAgentCommandLength) {
      fail(
        `${id}’s ${name} must be a command of up to ${maxAgentCommandLength} characters`,
        'command',
      )
    }
    const repo = read.optional(row, 'repo', (object, field) => {
      const given = read.string(object, field, `${id}’s ${name} repo must be a repo name`)
      return isCommandRepoName(given) ? given : fail(`${given} isn’t a repo name`, field)
    })
    return { name, command, ...(repo !== undefined && { repo }) }
  })
}

function text(row: JsonObject, field: string, what: string, limit: number, fail: Fail): string {
  const value = reader(fail).string(row, field, `${what} must be text`).trim()
  if (value === '') fail(`${what} is required`, field)
  if ([...value].length > limit) fail(`${what} is limited to ${limit} characters`, field)
  return value
}

export function keptSetupAgents(
  agents: readonly SetupAgentProposal[],
  removed: readonly string[],
): SetupAgentProposal[] {
  return agents.filter((agent) => !removed.includes(agent.id))
}

export function setupAgentFiles(agents: readonly SetupAgentProposal[]): string[] {
  return agents.length === 0
    ? []
    : ['.ted/agents.yaml', ...agents.map((agent) => `.ted/agents/${agent.id}.md`)]
}

export function parseRemovedAgents(value: Untyped, fail: Fail): string[] {
  const list = isArray(value)
    ? value
    : fail('removeAgents must be a list of Agent ids', 'removeAgents')
  if (list.length > maxSetupAgents) fail('removeAgents names too many Agents', 'removeAgents')
  const ids = list.map((id) =>
    isString(id) && isAgentId(id)
      ? id
      : fail('removeAgents must be a list of Agent ids', 'removeAgents'),
  )
  return [...new Set(ids)]
}
