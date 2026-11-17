import type { Proposal, ProposalCreated, SizeCheck } from '@ted/protocol'

export const sizeCheckTitle = 'Too big for one pull request per repo'

export const proposalFormat =
  'The file is JSON: a short `title`, an optional one-line `summary`, and `tasks`, one row per piece. Each row has a `title`, a one-line `scope`, an optional `description` for the Task, a `priority` (urgent, high, medium, low or none) and `blockedBy`, the row numbers that must merge first. On approval every row, row 1 included, becomes a new child Task of this Task, and this Task waits for them to merge. When they have, Ted finishes this Task unless it has commits or changes of its own.'

export function splitChosenMessage(text: string): string {
  return [
    'The human chose Split it.',
    ...(text !== '' ? [text] : []),
    `Post the pieces as a proposal with \`ted task propose --file <file>\`. ${proposalFormat} Then end your turn; Ted sends you the human’s answer.`,
  ].join('\n\n')
}

export function grillAnywayMessage(text: string): string {
  return [
    'The human chose Grill anyway: this stays one Task, and Ted set its Clarify depth to Grill.',
    ...(text !== '' ? [text] : []),
    'Ask your first round with `ted ask --round <file>`.',
  ].join('\n\n')
}

export function proposalChangesMessage(text: string): string {
  return [
    'The human asked for changes to your proposal:',
    text,
    'Post a revised proposal with `ted task propose --file <file>`, then end your turn.',
  ].join('\n\n')
}

export const parentWaitsNote =
  'This Task is now their parent and waits for them to merge. When they have, Ted finishes it unless it has commits or changes of its own; then carry on with that work. Leave the pieces to their own Task Leads.'

export function splitApprovedMessage(input: {
  proposal: Proposal
  created: ProposalCreated
  text: string
}): string {
  const { proposal, created, text } = input
  const made = created.tasks.map((t) => `${t.displayId} (row ${t.row})`).join(', ')
  const skipped = created.skipped.filter((row) => row <= proposal.rows.length)
  return [
    `The human approved the split. Ted created ${made} as child Tasks of this Task.${
      skipped.length > 0
        ? ` ${skipped.length === 1 ? 'Row' : 'Rows'} ${skipped.join(', ')} weren’t created.`
        : ''
    }`,
    ...(text !== '' ? [`They added:\n\n${text}`] : []),
    parentWaitsNote,
  ].join('\n\n')
}

export function splitApprovedSummary(created: ProposalCreated, text: string | undefined): string {
  const made = created.tasks.map((t) => `${t.displayId} (row ${t.row})`).join(', ')
  return [
    `approved the split; Ted created ${made} as child Tasks of this Task, which waits for them to merge`,
    ...(text !== undefined && text !== '' ? [`adding: ${text}`] : []),
  ].join('; ')
}

export function planOutsideNote(why: string, sizeCheck: SizeCheck): string {
  return [
    'This Task is too big for one pull request per repo, so the human is planning it outside Ted.',
    why,
    `A plan needs to settle:\n${sizeCheck.settle.map((point) => `- ${point}`).join('\n')}`,
    'When the plan is ready, put it in the description and start the Task again. Clarify runs again from there.',
  ].join('\n\n')
}

export const afterPlanningWhy =
  'You judged this Task too big, and the human took it away to plan it outside Ted. They have now started it again, and its description may hold the plan. Run Clarify as usual, starting with the size check.'

export function planInChatMessage(title: string): string {
  return [
    `The human chose Plan in chat. Ted opened a planning chat, “${title}”, where the human and a planner work out how to split this Task.`,
    'Wait for it: end your turn now and do nothing more on this Task. When the plan is approved, Ted makes this Task the parent of the Tasks it creates and stops this Run while they are built. If the chat ends without approval, Ted tells you to ask your size question again.',
  ].join('\n\n')
}

export function planApprovedLeadMessage(input: {
  planTitle: string
  created: ProposalCreated
  text: string
}): string {
  const { planTitle, created, text } = input
  const made = created.tasks.map((t) => `${t.displayId} (row ${t.row})`).join(', ')
  return [
    `The human approved the plan from the planning chat “${planTitle}”. Ted created ${made} as child Tasks of this Task.`,
    ...(text !== '' ? [`They added:\n\n${text}`] : []),
    parentWaitsNote,
  ].join('\n\n')
}

const planEndings = {
  stopped: 'was stopped',
  failed: 'failed',
  deleted: 'was deleted',
  archived: 'was archived',
} as const

export function planEndedLeadMessage(input: {
  planTitle: string
  outcome: keyof typeof planEndings
}): string {
  return [
    `The planning chat “${input.planTitle}” ${planEndings[input.outcome]} without an approved plan, so this Task is unchanged.`,
    'Ask your size question again with `ted clarify too-big`, so the human can choose another way.',
  ].join('\n\n')
}
