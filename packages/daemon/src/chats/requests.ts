import {
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

export function proposalRows(tasks: readonly ProposalRowInput[]): ProposalRow[] {
  return tasks.map((row) => ({
    title: row.title,
    scope: row.scope,
    ...(row.description !== undefined && { description: row.description }),
    priority: row.priority ?? 'none',
    blockedBy: row.blockedBy ?? [],
  }))
}

export function answerable(request: PostedRequest): void {
  if (request.answer?.kind === 'superseded')
    throw new RequestError(409, 'This request was replaced by a newer one')
  if (request.answer) throw new RequestError(409, 'This request has already been answered')
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
