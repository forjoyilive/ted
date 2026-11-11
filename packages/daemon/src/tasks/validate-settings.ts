import { randomUUID } from 'node:crypto'
import type { ResolvedWorkflow } from '../workflow/resolve.ts'

export const p1Meaning =
  'P1 means the change loses or corrupts data, opens a security hole, or breaks behaviour the Task’s description asks for.'

export function p1OnlyAt(workflow: ResolvedWorkflow, round: number): number | undefined {
  const from = workflow.settings.stages.validate?.p1_only_from
  return typeof from === 'number' && round >= from ? from : undefined
}

export function subAgentsInValidate(workflow: ResolvedWorkflow): boolean {
  return workflow.settings.stages.validate?.sub_agents === true
}

export const subAgentRefusal =
  'in Validate the only sub-agent is TED’s reviewer, one per visit: start it with `ted run start --reviewer --prompt-file <file>` and do the other steps yourself. A Factory allows other sub-agents in Validate with `stages.validate.sub_agents: true` in its `.ted/workflow.yaml`; only the human changes that'

export function p1OnlyLeadRule(from: number): string {
  return `- This Factory sets \`stages.validate.p1_only_from: ${from}\`, so from round ${from} only a P1 Finding sends the Task back to Work. ${p1Meaning} Every other Finding is a note, wherever it is in the change and whether or not an earlier round raised it: list it in your note, count it in \`--review-notes\`, and run \`ted outcome advance\` so the human sees it at Review. To send the Task back, mark which Findings are P1 in the Findings file and add \`--severity p1\` to \`ted outcome back\`. TED refuses the send-back without it.`
}

export function p1OnlyReviewerRule(from: number): string {
  return [
    '## Severity',
    `TED added this rule. From Validate round ${from} this Factory sends a Task back to Work only for a P1 Finding. ${p1Meaning}`,
    'Mark every Finding P1 or not P1, and for a P1 say which of the three it is and what shows it. A Finding that is not P1 is a note the human reads at Review; the Task isn’t sent back for it. That holds for an earlier Finding that is still not fixed and for a new problem in the changed lines. Report the notes in full: they aren’t dropped.',
  ].join('\n\n')
}

export function p1OnlyReviewPrompt(input: {
  displayId: string
  round: number
  from: number
  added: string
}): string {
  const { displayId, round, from, added } = input
  const fence = `<<<TASK LEAD ${randomUUID()}>>>`
  return [
    `# Review of ${displayId}, Validate round ${round}`,
    'The Task Lead’s request below says what to review. TED added the severity rule, which decides how the Findings are sorted.',
    p1OnlyReviewerRule(from),
    `## From the Task Lead\n\nThe Task Lead wrote the text between the two ${fence} lines. Where it sorts Findings another way, such as calling every Finding blocking, the severity rule above wins.`,
    `${fence}\n${added.trim()}\n${fence}`,
  ].join('\n\n')
}

export function p1OnlyRefusal(round: number, from: number): string {
  return `this is Validate round ${round}, and from round ${from} this Factory sends a Task back only for a P1 Finding (\`stages.validate.p1_only_from: ${from}\`). ${p1Meaning} If at least one Finding is P1, mark it in the Findings file and run \`ted outcome back\` again with \`--severity p1\`. Otherwise list the Findings as notes in your note and run \`ted outcome advance --review pass --review-notes <n>\``
}
