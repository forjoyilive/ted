import type { Billing, ConversationEntry, Run } from '@ted/protocol'
import type { AgentChat } from '../agents/agent.ts'
import type { Agent, Agents } from '../agents/index.ts'
import type { OutputFold, RunOutputReader } from './run-output.ts'

export interface ParsedOutput extends OutputFold {
  chat: AgentChat
  tokens(): number | undefined
  credential(): Billing | undefined
  cost(model: string | undefined): number | undefined
}

function parse(agent: Agent, cwd: string): ParsedOutput {
  const chat = agent.chatFrom(cwd)
  const costLines: string[] = []
  let added = 0
  let latestTotal: number | undefined
  let credential: Billing | undefined
  return {
    chat,
    add(entry: ConversationEntry) {
      chat.add(entry)
      const count = agent.tokensFrom(entry.line)
      if (count?.total) latestTotal = count.input + count.output
      else if (count) added += count.input + count.output
      credential ??= agent.credentialFrom(entry.line)?.billing
      if (agent.costLine(entry.line)) costLines.push(entry.line)
    },
    tokens() {
      const tokens = latestTotal ?? added
      return tokens > 0 ? tokens : undefined
    },
    credential: () => credential,
    cost: (model) => agent.costOf(costLines, model),
  }
}

export function parsedOutput(
  output: RunOutputReader,
  agents: Agents,
  run: Pick<Run, 'id' | 'agent' | 'cwd'>,
): ParsedOutput {
  return output.fold(run.id, 'parsed', () => parse(agents.get(run.agent), run.cwd))
}
