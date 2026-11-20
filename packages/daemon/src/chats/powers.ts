import { proposalFilesNote } from '@ted/protocol'
import { type AgentCommand, type AgentPower, agentPowerNames } from '@ted/protocol/agent-files'
import { RequestError } from '../errors.ts'

export interface Powered {
  name: string
  powers: readonly AgentPower[]
}

export function hasPower(agent: Powered, power: AgentPower): boolean {
  return agent.powers.includes(power)
}

export function requirePower(agent: Powered, power: AgentPower): void {
  if (!hasPower(agent, power))
    throw new RequestError(
      403,
      `${agent.name} doesn’t have the ${agentPowerNames[power]} power in this chat, so Ted refused this`,
    )
}

export const roundFormat =
  'The file is JSON: a short `title` that names the topic and doesn’t say how many questions there are, an optional `summary` in Markdown, one or two short sentences with only the context the user needs to answer, and `questions`. Each question has its `question`, your `recommended` answer, and, when there are a few likely answers, `choices` that include the recommended one. When a choice needs explaining, start it with a short line that names it, then a line break and the explanation; the app shows the first line as the choice’s label. Without `choices`, the human edits your recommended answer as text. When the human may pick several choices, add `"multiple": true` and make `recommended` a list of the choices you recommend; the app shows checkboxes.'

export const proposalFormat =
  'The file is JSON: a short `title`, an optional one-line `summary`, and `tasks`, one row per Task. Each row has a `title`, a one-line `scope`, an optional `description` that becomes the Task’s description, a `priority` (urgent, high, medium, low or none), `blockedBy`, the row numbers that must merge first, and `files`, the repo paths the row will likely change. ' +
  proposalFilesNote

export function chatAskCommands(): string {
  return [
    '- ted ask "<question>" [--choice "<answer>"]… [--multiple]: ask the human one question. It waits in their Inbox and in this chat. Choices become buttons; --multiple lets them pick several.',
    `- ted ask --round <file>: ask the human several questions at once. ${roundFormat}`,
    'After you ask, end your turn: Ted sends you the human’s answer as a message from Ted. One request waits at a time; to replace your own unanswered request, add --supersedes <request-id>.',
  ].join('\n')
}

export function chatProposeCommands(): string {
  return [
    `- ted task propose --file <file>: propose Tasks for this Factory. ${proposalFormat} Each Task should deliver a verifiable result in one pull request per repo.`,
    'When the human approves, Ted creates the Tasks in Backlog, one parent Task over them when there are several rows, and this chat stays open. After you propose, end your turn.',
  ].join('\n')
}

export const agentDraftFormat =
  'The file is JSON: `id` (lowercase letters, digits and hyphens), `name`, `instructions` (the Agent’s instructions file, in Markdown), `powers` (a list from ask, manage_tasks, manage_automations, propose_tasks, read_code, manage_agents), `"change": true` when it changes an Agent this Factory already has, and an optional one-paragraph `summary` for the human.'

export function chatAgentCommands(): string {
  return [
    '- ted coordinator agents: this Factory’s Agents, each with its id, name, where it is defined, its powers and its full instructions.',
    `- ted coordinator agent-draft --file <file> [--supersedes <request-id>]: draft a new Agent, or a change to one, for the human to create. ${agentDraftFormat} For a change, give the whole new instructions and powers, not only what differs.`,
    'Ted shows the human the draft as a card in this chat and their Inbox. They may edit it, untick powers and pick the Library (every Factory on this Mac) or this Factory (a settings pull request); nothing is saved until they click Create. You can’t save Agent files yourself, and an Agent can’t be given commands from here. After you draft, end your turn: Ted sends you what the human did.',
  ].join('\n')
}

export function checkoutLine(where: string): string {
  return `${where} Read it as much as you need. Anything you write there is never pushed and is thrown away when this chat is archived or ends.`
}

const shownCommandLength = 200

function shown(command: string): string {
  const line = command.replace(/\s+/g, ' ').trim()
  return line.length > shownCommandLength ? `${line.slice(0, shownCommandLength)}…` : line
}

export function chatOutsideCommandLines(
  powers: readonly AgentPower[],
  commands: readonly AgentCommand[] | undefined,
): string[] {
  if (!powers.includes('run_outside')) return []
  const listed = commands ?? []
  if (listed.length === 0) return []
  return [
    '- ted agent run-outside <name> [argument]: ask Ted to run one of the outside commands below on the user’s Mac, outside the sandbox, in the repo’s local folder. A command written with <slot> takes one argument: letters, digits, dot, dash and underscore only. The first time, the user sees a card with Run; nothing runs until they click it, unless they allowed that command always. One outside command runs at a time in this Factory. After you ask, end your turn: Ted sends you the output, or the user’s refusal, as a message from Ted.',
    'These commands can push, publish or use the keychain. Ask only for what the user asked you to do, and say in the chat why before you ask.',
    ...listed.map(
      (c) => `  - ${c.name}${c.repo ? ` (in ${c.repo})` : ''}: \`${shown(c.command)}\``,
    ),
  ]
}

export function chatCommandLines(
  powers: readonly AgentPower[],
  commands: readonly AgentCommand[] | undefined,
): string[] {
  if (!powers.includes('run_commands') || !powers.includes('read_code')) return []
  const listed = commands ?? []
  if (listed.length === 0) return []
  return [
    '- ted agent run <name>: Ted runs one of the commands below in your copy of the code, in its sandbox, and prints the output and exit status. It takes no arguments, and one command runs at a time; a second one waits for the first. The command can write only inside your copy.',
    ...listed.map(
      (c) => `  - ${c.name}${c.repo ? ` (in ${c.repo})` : ''}: \`${shown(c.command)}\``,
    ),
  ]
}
