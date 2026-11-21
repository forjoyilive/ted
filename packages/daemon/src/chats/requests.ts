import {
  type AnswerRequest,
  type ChatRequest,
  type CommentAnswer,
  linkSharedFiles,
  type Priority,
  type ProposalRow,
  type ProposalRowInput,
  planTitleLength,
  type Round,
  type RoundAnswer,
} from '@ted/protocol'
import { RequestError } from '../errors.ts'

export interface PostedRequest {
  id: string
  kind: string
  answer?: { kind: string }
}

export interface PostPlan {
  supersedes?: string
  roundNumber: number
}

function isOpen(request: PostedRequest): boolean {
  return request.answer === undefined && request.kind !== 'note'
}

export function refuseWhileWaiting(requests: readonly PostedRequest[], kind: string): void {
  const waiting = requests.find(isOpen)
  if (!waiting) return
  const replace = waiting.kind === kind ? `, or replace it with --supersedes ${waiting.id}` : ''
  throw new RequestError(
    409,
    `Your ${waiting.kind} (request ${waiting.id}) is still waiting on the human; wait for their answer${replace}`,
  )
}

export function planPost(
  requests: readonly PostedRequest[],
  post: { kind: string; supersedes?: string },
): PostPlan {
  const { kind, supersedes } = post
  if (supersedes !== undefined) {
    const old = requests.find((r) => r.id === supersedes)
    if (!old) throw new RequestError(404, `no request ${supersedes} in this chat`)
    if (old.kind !== kind) throw new RequestError(400, `a ${kind} can replace only a ${kind}`)
    if (old.answer) throw new RequestError(409, 'that request has already been answered')
  }
  refuseWhileWaiting(
    requests.filter((r) => r.id !== supersedes),
    kind,
  )
  const rounds = requests.filter((r) => r.kind === 'round' && r.answer?.kind !== 'superseded')
  return {
    ...(supersedes !== undefined && { supersedes }),
    roundNumber: rounds.length + (supersedes === undefined ? 1 : 0),
  }
}

export function proposalRows(
  tasks: readonly ProposalRowInput[],
  repos: readonly string[],
  priority: Priority = 'none',
): ProposalRow[] {
  if (repos.length > 1) {
    for (const [i, row] of tasks.entries()) {
      const outside = row.files.find((path) => !repos.includes(path.split('/')[0] ?? ''))
      if (outside !== undefined) {
        throw new RequestError(
          400,
          `row ${i + 1}’s file "${outside}" must start with one of this Factory’s repos: ${repos.join(', ')}`,
        )
      }
    }
  }
  const rows = tasks.map((row) => ({
    title: row.title,
    scope: row.scope,
    ...(row.description !== undefined && { description: row.description }),
    priority: row.priority ?? priority,
    blockedBy: row.blockedBy ?? [],
    files: row.files,
  }))
  return linkSharedFiles(rows, repos)
}

export function answerable(request: PostedRequest): void {
  if (request.answer?.kind === 'superseded')
    throw new RequestError(409, 'This request was replaced by a newer one')
  if (request.answer) throw new RequestError(409, 'This request has already been answered')
}

export function questionAnswer(
  asked: Pick<ChatRequest, 'id' | 'body' | 'choices' | 'multiple'>,
  answer: AnswerRequest,
  at: string,
) {
  if (answer.action !== 'answer')
    throw new RequestError(400, 'Answer a question with a choice or a message')
  const text = answer.text?.trim() ?? ''
  if (answer.choice !== undefined && !asked.choices?.includes(answer.choice))
    throw new RequestError(409, `“${answer.choice}” isn’t one of the question’s choices`)
  if (answer.choices !== undefined && !asked.multiple)
    throw new RequestError(400, 'This question takes one choice')
  const outside = answer.choices?.find((x) => !asked.choices?.includes(x))
  if (outside !== undefined)
    throw new RequestError(409, `“${outside}” isn’t one of the question’s choices`)
  if (text === '' && answer.choice === undefined && (answer.choices ?? []).length === 0)
    throw new RequestError(400, 'Pick a choice or write an answer')
  const picked = answer.choices ?? (answer.choice !== undefined ? [answer.choice] : [])

  return {
    message: [
      `The human answered your question (request ${asked.id}):`,
      asked.body,
      ...(picked.length > 0 ? [`Their choice: ${picked.join('; ')}`] : []),
      ...(text !== '' ? [`Their words: ${text}`] : []),
    ].join('\n\n'),
    answer: {
      kind: 'answered',
      at,
      ...(answer.choice !== undefined && { choice: answer.choice }),
      ...(answer.choices !== undefined && { choices: answer.choices }),
      ...(text !== '' && { text }),
    } satisfies CommentAnswer,
  }
}

export function roundAnswerMessage(
  request: { id: string; title?: string; round?: Round },
  answers: readonly RoundAnswer[],
  next?: string,
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
    `The human answered Round ${request.round?.number ?? ''} “${request.title ?? ''}” (request ${request.id}):`,
    lines.join('\n'),
    ...(next !== undefined ? [next] : []),
  ].join('\n\n')
}

export function chatTitle(title: string): string {
  const name = title.trim().replace(/\s+/g, ' ')
  if (name === '') throw new RequestError(400, 'A chat needs a title')
  if ([...name].length > planTitleLength) {
    throw new RequestError(400, `titles are at most ${planTitleLength} characters`)
  }
  return name
}
