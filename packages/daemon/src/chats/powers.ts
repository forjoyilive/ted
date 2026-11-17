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

export function checkoutLine(where: string): string {
  return `${where} Read it as much as you need. Anything you write there is never pushed and is thrown away when this chat is archived or ends.`
}

const shownCommandLength = 200

function shown(command: string): string {
  const line = command.replace(/\s+/g, ' ').trim()
  return line.length > shownCommandLength ? `${line.slice(0, shownCommandLength)}…` : line
}

export function chatCommandLines(
  powers: readonly AgentPower[],
  commands: readonly AgentCommand[] | undefined,
): string[] {
  if (!powers.includes('run_commands') || !powers.includes('read_code')) return []
  const listed = commands ?? []
  if (listed.length === 0) return []
  return [
    '- ted agent run <name>: TED runs one of the commands below in your copy of the code, in its sandbox, and prints the output and exit status. It takes no arguments, and one command runs at a time; a second one waits for the first. The command can write only inside your copy.',
    ...listed.map(
      (c) => `  - ${c.name}${c.repo ? ` (in ${c.repo})` : ''}: \`${shown(c.command)}\``,
    ),
  ]
}
