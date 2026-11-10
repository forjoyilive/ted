import type { Proposal, ProposalCreated, SizeCheck } from '@ted/protocol'

export const sizeCheckTitle = 'Too big for one pull request per repo'

export const proposalFormat =
  'The file is JSON: a short `title`, an optional one-line `summary`, and `tasks`, one row per piece. Each row has a `title`, a one-line `scope`, an optional `description` for the Task, a `priority` (urgent, high, medium, low or none) and `blockedBy`, the row numbers that must merge first. Row 1 is this Task: on approval it narrows to row 1’s title and its `description` (or its `scope`) and carries on, so row 1 can’t be blocked.'

export function splitChosenMessage(text: string): string {
  return [
    'The user chose Split it.',
    ...(text !== '' ? [text] : []),
    `Post the pieces as a proposal with \`ted task propose --file <file>\`. ${proposalFormat} Then end your turn; TED sends you the user’s answer.`,
  ].join('\n\n')
}

export function grillAnywayMessage(text: string): string {
  return [
    'The user chose Grill anyway: this stays one Task, and TED set its Clarify depth to Grill.',
    ...(text !== '' ? [text] : []),
    'Ask your first round with `ted ask --round <file>`.',
  ].join('\n\n')
}

export function proposalChangesMessage(text: string): string {
  return [
    'The user asked for changes to your proposal:',
    text,
    'Post a revised proposal with `ted task propose --file <file>`, then end your turn.',
  ].join('\n\n')
}

export function splitApprovedMessage(input: {
  displayId: string
  proposal: Proposal
  created: ProposalCreated
  narrowed?: { title: string; description: string }
  text: string
}): string {
  const { displayId, proposal, created, narrowed, text } = input
  const made = created.tasks.map((t) => `${t.displayId} (row ${t.row})`).join(', ')
  const skipped = created.skipped.filter((row) => row <= proposal.rows.length)
  return [
    `The user approved the split. TED created ${made} in Backlog.${
      skipped.length > 0
        ? ` ${skipped.length === 1 ? 'Row' : 'Rows'} ${skipped.join(', ')} weren’t created.`
        : ''
    }`,
    ...(text !== '' ? [`They added:\n\n${text}`] : []),
    ...(narrowed
      ? [
          `This Task, ${displayId}, is now row 1: “${narrowed.title}”. Its description now reads:\n\n${narrowed.description}`,
          'Carry on with Clarify for this narrower Task. Leave the other pieces to their own Task Leads.',
        ]
      : []),
  ].join('\n\n')
}

export function splitApprovedSummary(
  proposal: Proposal,
  created: ProposalCreated,
  text: string | undefined,
): string {
  const made = created.tasks.map((t) => `${t.displayId} (row ${t.row})`).join(', ')
  const first = proposal.firstPiece ? proposal.rows[0] : undefined
  return [
    `approved the split; TED created ${made} in Backlog`,
    ...(first
      ? [
          `this Task is now row 1, “${first.title}”: ${first.description ?? first.scope} Carry on with Clarify for it and leave the other pieces to their own Task Leads`,
        ]
      : []),
    ...(text !== undefined && text !== '' ? [`adding: ${text}`] : []),
  ].join('; ')
}

export function planOutsideNote(why: string, sizeCheck: SizeCheck): string {
  return [
    'This Task is too big for one pull request per repo, so the user is planning it outside TED.',
    why,
    `A plan needs to settle:\n${sizeCheck.settle.map((point) => `- ${point}`).join('\n')}`,
    'When the plan is ready, put it in the description and start the Task again. Clarify runs again from there.',
  ].join('\n\n')
}

export const afterPlanningWhy =
  'You judged this Task too big, and the user took it away to plan it outside TED. They have now started it again, and its description may hold the plan. Run Clarify as usual, starting with the size check.'

export function planInChatMessage(title: string): string {
  return [
    `The user chose Plan in chat. TED opened a planning chat, “${title}”, where the user and a planner work out how to split this Task.`,
    'Wait for it: end your turn now and do nothing more on this Task. When the plan is approved, TED tells you what this Task became and you carry on with Clarify. If the chat ends without approval, TED tells you to ask your size question again.',
  ].join('\n\n')
}

export function planApprovedLeadMessage(input: {
  displayId: string
  planTitle: string
  narrowed: { title: string; description: string }
  created: ProposalCreated
  text: string
}): string {
  const { displayId, planTitle, narrowed, created, text } = input
  const made = created.tasks.map((t) => `${t.displayId} (row ${t.row})`).join(', ')
  return [
    `The user approved the plan from the planning chat “${planTitle}”. TED created ${made} in Backlog.`,
    ...(text !== '' ? [`They added:\n\n${text}`] : []),
    `This Task, ${displayId}, is now row 1: “${narrowed.title}”. Its description now reads:\n\n${narrowed.description}`,
    'Carry on with Clarify for this narrower Task. Leave the other pieces to their own Task Leads.',
  ].join('\n\n')
}

const planEndings = {
  stopped: 'was stopped',
  failed: 'failed',
  deleted: 'was deleted',
} as const

export function planEndedLeadMessage(input: {
  planTitle: string
  outcome: keyof typeof planEndings
}): string {
  return [
    `The planning chat “${input.planTitle}” ${planEndings[input.outcome]} without an approved plan, so this Task is unchanged.`,
    'Ask your size question again with `ted clarify too-big`, so the user can choose another way.',
  ].join('\n\n')
}
