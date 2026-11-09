import type { PlanRequest, PlanTask, RoundAnswer } from '@ted/protocol'
import type { StoredFactory } from '../store/index.ts'
import type { FactoryRepoEntry } from '../tasks/repos.ts'

export const planOpening = '## What the human wants to plan'

export const planResumePrompt =
  'Your process stopped before you finished, so TED resumed your session. Check where you were in the planning chat, then carry on.'

const roundFormat =
  'The file is JSON: a short `title`, an optional one-line `summary`, and `questions`. Each question has its `question`, your `recommended` answer, and, when there are a few likely answers, `choices` that include the recommended one. Without `choices`, the human edits your recommended answer as text.'

const proposalFormat =
  'The file is JSON: a short `title`, an optional one-line `summary`, and `tasks`, one row per Task. Each row has a `title`, a one-line `scope`, an optional `description` that becomes the Task’s description, a `priority` (urgent, high, medium, low or none) and `blockedBy`, the row numbers that must merge first.'

export function plannerInstructions(input: {
  factory: StoredFactory
  entries: readonly FactoryRepoEntry[]
  folder: string
  earlier?: string
}): string {
  const { factory, entries, folder, earlier } = input
  const where =
    entries.length === 1
      ? `Your working folder is a fresh checkout of ${entries[0]?.repo ?? factory.repo} at the latest base branch.`
      : `Your working folder, ${folder}, holds a fresh checkout of each of the Factory’s repos at its latest base branch: ${entries.map((e) => `\`${e.name}/\` (${e.repo})`).join(', ')}.`
  return [
    '# You are the planner in a TED planning chat',
    [
      `The human wants to work out a piece of work in the ${factory.name} Factory that is too big for one Task. Talk it through with them, settle what needs settling, and end by proposing Tasks, with which ones block which, for them to approve. You plan; you don’t build. ${where} Read it as much as you need. Anything you write there is never pushed and is thrown away when this chat ends.`,
      '',
      '- For research that takes a while, start sub-agents of your own and give each a narrow question.',
      `- Ask the human questions in rounds with \`ted ask --round <file>\`. ${roundFormat} Then end your turn; TED sends you their answers. While a round is open the human may message you about it; answer them, and if your recommendation changes, replace the round with \`ted ask --supersedes <request-id> --round <file>\`.`,
      `- When the plan is clear, post it with \`ted task propose --file <file>\`. ${proposalFormat} Each Task should be one pull request per repo. Then end your turn.`,
      '- If the human asks for changes, post a revised proposal the same way; it replaces the old one.',
      '- When the human approves, TED creates the Tasks in Backlog and ends this chat. If they message you instead, reply in the chat.',
    ].join('\n'),
    ...(earlier !== undefined && earlier !== ''
      ? [
          '## The earlier planning chat this one builds on',
          `The human started this chat from an earlier one with **Plan more from here**. Build on what it settled and created; don’t ask again what it already answered.\n\n${earlier}`,
        ]
      : []),
    planOpening,
  ].join('\n\n')
}

function answerLines(request: PlanRequest): string[] {
  const answers = request.answer?.kind === 'answered' ? (request.answer.answers ?? []) : []
  return (request.round?.questions ?? []).flatMap((question, i) => {
    const answer = answers[i]
    return [
      `- ${question.question}`,
      answer
        ? `  Answer: ${answer.answer}${answer.note !== undefined ? ` (note: ${answer.note})` : ''}`
        : '  Not answered.',
    ]
  })
}

export function earlierPlanContext(input: {
  title: string
  message: string
  requests: readonly PlanRequest[]
  tasks: readonly PlanTask[]
}): string {
  const { title, message, requests, tasks } = input
  const rounds = requests.filter((r) => r.kind === 'round' && r.answer?.kind !== 'superseded')
  const proposal = requests.findLast((r) => r.kind === 'proposal')
  const parts = [`### “${title}”`, `The human’s first message:\n\n${message}`]
  for (const round of rounds) {
    parts.push(
      [`#### Round ${round.round?.number ?? ''}: ${round.title ?? ''}`, ...answerLines(round)].join(
        '\n',
      ),
    )
  }
  if (proposal?.proposal) {
    const outcome =
      proposal.answer?.kind === 'approved'
        ? 'approved'
        : proposal.answer?.kind === 'changes-requested'
          ? `changes requested: ${proposal.answer.text}`
          : 'not approved'
    parts.push(
      [
        `#### Latest proposal: ${proposal.title ?? ''} (${outcome})`,
        ...proposal.proposal.rows.map(
          (row, i) =>
            `${i + 1}. ${row.title}: ${row.scope}${row.blockedBy.length > 0 ? ` (blocked by ${row.blockedBy.join(', ')})` : ''}`,
        ),
      ].join('\n'),
    )
  }
  parts.push(
    tasks.length === 0
      ? 'It created no Tasks.'
      : [
          '#### Tasks it created',
          ...tasks.map(
            (t) =>
              `- ${t.displayId} ${t.title} (${t.stage}${t.blockedBy.length > 0 ? `, blocked by ${t.blockedBy.join(', ')}` : ''})`,
          ),
        ].join('\n'),
  )
  return parts.join('\n\n')
}

export function planRoundAnswerMessage(
  request: PlanRequest,
  answers: readonly RoundAnswer[],
): string {
  const lines = (request.round?.questions ?? []).map((question, i) => {
    const answer = answers[i]
    if (!answer) return ''
    const tag = answer.changed
      ? `changed from your recommendation “${question.recommended}”`
      : 'recommended'
    return [
      `${i + 1}. ${question.question}`,
      `   ${answer.answer} (${tag})`,
      ...(answer.note !== undefined ? [`   Note: ${answer.note}`] : []),
    ].join('\n')
  })
  return [
    `The human answered Round ${request.round?.number ?? ''} “${request.title ?? ''}”:`,
    lines.join('\n'),
    'If anything is still open, ask another round. When nothing is, post your proposal with `ted task propose --file <file>`.',
  ].join('\n\n')
}

export function planChangesMessage(text: string): string {
  return [
    'The human asked for changes to your proposal:',
    text,
    'Post a revised proposal with `ted task propose --file <file>`, then end your turn.',
  ].join('\n\n')
}

export function planApprovedMessage(
  created: readonly { row: number; displayId: string }[],
): string {
  return `The human approved your proposal. TED created ${created.map((c) => `${c.displayId} (row ${c.row})`).join(', ')} in Backlog and is ending this chat. Thank you.`
}

export function planCreatedNote(ids: readonly string[]): string {
  return `Created ${ids.length} ${ids.length === 1 ? 'Task' : 'Tasks'} in Backlog: ${ids.join(', ')}`
}
