import { type AgentPower, agentPowerNames } from '@ted/protocol/agent-files'
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
      `${agent.name} doesn’t have the ${agentPowerNames[power]} power in this chat, so TED refused this`,
    )
}

export const roundFormat =
  'The file is JSON: a short `title` that names the topic and doesn’t say how many questions there are, an optional `summary` in Markdown with the context the user needs before the questions, and `questions`. Each question has its `question`, your `recommended` answer, and, when there are a few likely answers, `choices` that include the recommended one. When a choice needs explaining, start it with a short line that names it, then a line break and the explanation; the app shows the first line as the choice’s label. Without `choices`, the human edits your recommended answer as text. When the human may pick several choices, add `"multiple": true` and make `recommended` a list of the choices you recommend; the app shows checkboxes.'

export const proposalFormat =
  'The file is JSON: a short `title`, an optional one-line `summary`, and `tasks`, one row per Task. Each row has a `title`, a one-line `scope`, an optional `description` that becomes the Task’s description, a `priority` (urgent, high, medium, low or none) and `blockedBy`, the row numbers that must merge first.'

export function chatAskCommands(): string {
  return [
    '- ted ask "<question>" [--choice "<answer>"]… [--multiple]: ask the human one question. It waits in their Inbox and in this chat. Choices become buttons; --multiple lets them pick several.',
    `- ted ask --round <file>: ask the human several questions at once. ${roundFormat}`,
    'After you ask, end your turn: TED sends you the human’s answer as a message from TED. One request waits at a time; to replace your own unanswered request, add --supersedes <request-id>.',
  ].join('\n')
}

export function chatProposeCommands(): string {
  return [
    `- ted task propose --file <file>: propose Tasks for this Factory. ${proposalFormat} Each Task should deliver a verifiable result in one pull request per repo.`,
    'When the human approves, TED creates the Tasks in Backlog, one parent Task over them when there are several rows, and this chat stays open. After you propose, end your turn.',
  ].join('\n')
}

export const agentDraftFormat =
  'The file is JSON: `id` (lowercase letters, digits and hyphens), `name`, `instructions` (the Agent’s instructions file, in Markdown), `powers` (a list from ask, manage_tasks, propose_tasks, read_code, manage_agents), `"change": true` when it changes an Agent this Factory already has, and an optional one-paragraph `summary` for the human.'

export function chatAgentCommands(): string {
  return [
    '- ted coordinator agents: this Factory’s Agents, each with its id, name, where it is defined, its powers and its full instructions.',
    `- ted coordinator agent-draft --file <file> [--supersedes <request-id>]: draft a new Agent, or a change to one, for the human to create. ${agentDraftFormat} For a change, give the whole new instructions and powers, not only what differs.`,
    'TED shows the human the draft as a card in this chat and their Inbox. They may edit it, untick powers and pick the Library (every Factory on this Mac) or this Factory (a settings pull request); nothing is saved until they click Create. You can’t save Agent files yourself, and an Agent can’t be given commands from here. After you draft, end your turn: TED sends you what the human did.',
  ].join('\n')
}

export function checkoutLine(where: string): string {
  return `${where} Read it as much as you need. Anything you write there is never pushed and is thrown away when this chat is archived or ends.`
}
