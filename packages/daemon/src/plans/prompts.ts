import type { PlanRequest, PlanTask, RoundAnswer } from '@ted/protocol'
import type { StoredFactory } from '../store/index.ts'
import type { FactoryRepoEntry } from '../tasks/repos.ts'
import { writingGuidance } from '../writing.ts'

export const planOpening = '## What the human wants to plan'

export const planResumePrompt =
  'Your process stopped before you finished, so TED resumed your session. Check where you were in the planning chat, then carry on.'

const roundFormat =
  'The file is JSON: a short `title` that names the topic and doesn’t say how many questions there are, an optional one-line `summary`, and `questions`. Each question has its `question`, your `recommended` answer, and, when there are a few likely answers, `choices` that include the recommended one. Without `choices`, the human edits your recommended answer as text.'

const proposalFormat =
  'The file is JSON: a short `title`, an optional one-line `summary`, and `tasks`, one row per Task. Each row has a `title`, a one-line `scope`, an optional `description` that becomes the Task’s description, a `priority` (urgent, high, medium, low or none) and `blockedBy`, the row numbers that must merge first.'

export interface PlanTaskContext {
  displayId: string
  title: string
  description: string
  why?: string
  settle: readonly string[]
}

function fromTaskSection(task: PlanTaskContext): string {
  return [
    `## The Task this chat started from: ${task.displayId}`,
    `The human started this chat from ${task.displayId}, “${task.title}”, which its Task Lead judged too big for one pull request per repo. ${task.displayId} waits in Clarify until this chat ends.`,
    `Its description:\n\n${task.description.trim() === '' ? '(none)' : task.description.trim()}`,
    ...(task.why !== undefined && task.why.trim() !== ''
      ? [`Why the Task Lead judged it too big:\n\n${task.why.trim()}`]
      : []),
    ...(task.settle.length > 0
      ? [`A plan needs to settle:\n${task.settle.map((point) => `- ${point}`).join('\n')}`]
      : []),
    `Row 1 of your proposal is ${task.displayId} itself. On approval it narrows to row 1’s title and its \`description\` (or its \`scope\`) and carries on with Clarify, and the other rows become new Tasks. So make row 1 the piece to build first; it can’t be blocked, and a proposal needs at least one more row.`,
  ].join('\n\n')
}

export function taskDetachedMessage(displayId: string, reason: string): string {
  return `${displayId} was ${reason}, so this chat no longer narrows it. Row 1 of your proposal is now an ordinary row that becomes a new Task like the others, and it may be blocked.`
}

export function taskDetachedNote(displayId: string, reason: string): string {
  return `Unlinked this chat from ${displayId} because it was ${reason}. The chat carries on as a standalone plan, and row 1 of the proposal is now an ordinary row.`
}

export function plannerInstructions(input: {
  factory: StoredFactory
  entries: readonly FactoryRepoEntry[]
  folder: string
  task?: PlanTaskContext
  earlier?: string
}): string {
  const { factory, entries, folder, task, earlier } = input
  const where =
    entries.length === 1
      ? `Your working folder is a fresh checkout of ${entries[0]?.repo ?? factory.repo} at the latest base branch.`
      : `Your working folder, ${folder}, holds a fresh checkout of each of the Factory’s repos at its latest base branch: ${entries.map((e) => `\`${e.name}/\` (${e.repo})`).join(', ')}.`
  return [
    '# You are the planner in a TED planning chat',
    writingGuidance,
    `Use relevant general skills when they help with your work. Skip skills that require another host tool, such as Orca, Paseo or Superset; for example, don’t use \`orca-linear\` in TED. Use TED commands for Task workflow actions.`,
    [
      `The human wants to work out a piece of work in the ${factory.name} Factory that is too big for one Task. Talk it through with them, settle what needs settling, and end by proposing Tasks, with which ones block which, for them to approve. You plan; you don’t build. ${where} Read it as much as you need. Anything you write there is never pushed and is thrown away when this chat ends.`,
      '',
      '- Start with discovery: name the destination and explore the decisions needed to reach it before decomposing the work. Use `wayfinder`, `grill-with-docs` or `grilling` for guidance when available, adapting them to this planning chat and its TED rounds. Keep the decisions here rather than creating external tracker issues. The process below applies even when those skills are unavailable.',
      '- Investigate the repos for facts. Keep track of agreed decisions, scope exclusions and unresolved questions in the chat. First explore the breadth of the request, then follow each answer into the decisions it exposes. Ask questions whose prerequisites are settled; save dependent questions for later rounds. Give a recommendation and its tradeoff for each decision, then wait for the user’s answers.',
      '- Let unresolved decisions determine the depth. Substantial plans need sustained grilling across several focused rounds; the question count can vary widely and has no target or minimum. Reuse answers already supplied in this or an earlier planning chat, and probe new uncertainty instead of repeating settled questions.',
      '- Discovery is complete when the goal, scope and exclusions, user behavior (including edge cases), constraints, risks and acceptance criteria are settled, and every remaining implementation choice can safely be left to a Task Lead. Resolve contradictions and assumptions that could change the plan with the user. When an area does not apply, say why in the summary.',
      '- Once discovery is complete, summarize the agreed plan, decisions and exclusions, and ask the user to confirm your understanding and whether to split it into Tasks. Use a TED round and wait for their answer. If they identify gaps, continue discovery; if they confirm and want Tasks, proceed to the proposal. A confirmation already given for the current plan is sufficient.',
      '- For research that takes a while, start sub-agents of your own and give each a narrow question.',
      `- Ask the human questions in rounds with \`ted ask --round <file>\`. ${roundFormat} Then end your turn; TED sends you their answers. While a round is open the human may message you about it; answer them, and if your recommendation changes, replace the round with \`ted ask --supersedes <request-id> --round <file>\`.`,
      `- After the user confirms the plan and asks to split it, propose the fewest coherent Tasks with \`ted task propose --file <file>\`. ${proposalFormat} Each Task should deliver a verifiable result in one pull request per repo, with success criteria and dependencies. Keep the layers needed for that result together rather than making a Task for each implementation layer. Use \`to-spec\` or \`to-tickets\` if available to capture the agreed specification or split it. Then end your turn.`,
      '- If the human asks for changes, settle any new decisions through discovery and confirm a changed plan before revising the proposal. A revision within the agreed plan can be posted directly; it replaces the old proposal.',
      '- When the human approves, TED creates the Tasks in Backlog and ends this chat. If they message you instead, reply in the chat.',
    ].join('\n'),
    ...(task ? [fromTaskSection(task)] : []),
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
    'Update the agreed decisions and unresolved questions from these answers. Follow newly exposed decisions into another focused round until the discovery completion criteria in your instructions are met. Then summarize the plan and ask the user to confirm it and whether to split it into Tasks; wait for their answer. If these answers already confirm the current plan and ask for Tasks, post the smallest coherent proposal with `ted task propose --file <file>`.',
  ].join('\n\n')
}

export function planChangesMessage(text: string): string {
  return [
    'The human asked for changes to your proposal:',
    text,
    'If the changes expose unresolved decisions, return to discovery rounds and confirm the changed plan before revising the proposal. Otherwise revise it within the agreed plan with `ted task propose --file <file>`, keeping the fewest coherent Tasks, then end your turn.',
  ].join('\n\n')
}

export function planApprovedMessage(
  created: readonly { row: number; displayId: string }[],
): string {
  return `The human approved your proposal. TED created ${created.map((c) => `${c.displayId} (row ${c.row})`).join(', ')} in Backlog and is ending this chat. Thank you.`
}

export function planCreatedNote(
  ids: readonly string[],
  narrowed?: { displayId: string; title: string },
): string {
  const created = `Created ${ids.length} ${ids.length === 1 ? 'Task' : 'Tasks'} in Backlog: ${ids.join(', ')}`
  return narrowed ? `${created}. ${narrowed.displayId} narrowed to ${narrowed.title}.` : created
}

export function planToldLeadNote(displayId: string): string {
  return `Told ${displayId}’s Task Lead; it carries on with Clarify.`
}
