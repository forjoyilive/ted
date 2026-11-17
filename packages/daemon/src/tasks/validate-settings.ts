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

const conflictIsP1 =
  'In this round a conflict resolution that drops or breaks what the base branch changed in the conflicting lines counts as P1 too.'

export function p1OnlyLeadRule(from: number, options: { conflict?: boolean } = {}): string {
  return `- This Factory sets \`stages.validate.p1_only_from: ${from}\`, so from round ${from} a new finding sends the Task back to Work only if it is P1. ${p1Meaning}${options.conflict ? ` ${conflictIsP1}` : ''} An earlier round’s finding that is still not fixed stays blocking, whatever its severity. Every other new finding is a note, wherever it is in the change: list it in your note, count it in \`--review-notes\`, and run \`ted outcome advance\` so the human sees it at Review. To send the Task back, say in the findings file which findings are P1 and which are earlier findings still not fixed, and add \`--severity p1\` to \`ted outcome back\` when at least one finding is P1, or \`--severity unfixed\` when the only blocking findings are earlier ones still not fixed. TED refuses the send-back without one of them.`
}

export function p1OnlyReviewerRule(
  from: number,
  options: { conflict?: boolean; earlier?: boolean } = {},
): string {
  const earlier =
    options.earlier === false
      ? ''
      : 'An earlier finding that is still not fixed stays blocking, whatever its severity: report it as not fixed. '
  return [
    '## Severity',
    `TED added this rule. From Validate round ${from} this Factory sends a Task back to Work for a new finding only if it is P1. ${p1Meaning}${options.conflict ? ` ${conflictIsP1}` : ''}`,
    `${earlier}Mark every new finding P1 or not P1, and for a P1 say which kind it is and what shows it. A new finding that is not P1 is a note the human reads at Review; the Task isn’t sent back for it, wherever it is in the change. Report the notes in full: they aren’t dropped.`,
  ].join('\n\n')
}

export function p1OnlyReviewPrompt(input: {
  displayId: string
  round: number
  from: number
  added: string
  conflict?: boolean
}): string {
  const { displayId, round, from, added, conflict } = input
  const fence = `<<<TASK LEAD ${randomUUID()}>>>`
  return [
    `# Review of ${displayId}, Validate round ${round}`,
    'The Task Lead’s request below says what to review. TED added the severity rule, which decides how the findings are sorted.',
    p1OnlyReviewerRule(from, { ...(conflict && { conflict }) }),
    `## From the Task Lead\n\nThe Task Lead wrote the text between the two ${fence} lines. Where it sorts findings another way, such as calling every new finding blocking, the severity rule above wins.`,
    `${fence}\n${added.trim()}\n${fence}`,
  ].join('\n\n')
}

export function p1OnlyRefusal(round: number, from: number): string {
  return `this is Validate round ${round}, and from round ${from} this Factory sends a Task back for a new finding only if it is P1 (\`stages.validate.p1_only_from: ${from}\`). ${p1Meaning} An earlier round’s finding that is still not fixed stays blocking. If at least one finding is P1, say which in the findings file and run \`ted outcome back\` again with \`--severity p1\`. If the only blocking findings are earlier ones still not fixed, say which and add \`--severity unfixed\`. Otherwise list the findings as notes in your note and run \`ted outcome advance --review pass --review-notes <n>\``
}

export function noEarlierFindingRefusal(round: number): string {
  return `\`--severity unfixed\` says an earlier round’s finding is still not fixed, but no earlier round of Validate sent this Task back with findings before round ${round}. If at least one finding is P1, run \`ted outcome back\` again with \`--severity p1\`. Otherwise list the findings as notes in your note and run \`ted outcome advance --review pass --review-notes <n>\``
}
