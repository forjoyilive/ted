import { type Comment, joinChoices } from '@ted/protocol'

export function answerMessage(comment: Comment, lines?: string): string {
  const answer = comment.answer
  if (answer?.kind !== 'answered') throw new Error('an answer message needs an answered question')
  return [
    `${comment.autopilotAnswered ? 'Autopilot' : 'The user'} replied to “${comment.title ?? comment.body.split('\n').find((line) => line.trim() !== '') ?? ''}”:`,
    ...(answer.choice !== undefined ? [answer.choice] : []),
    ...(answer.choices !== undefined && answer.choices.length > 0
      ? [joinChoices(answer.choices)]
      : []),
    ...(answer.text !== undefined ? [answer.text] : []),
    ...(lines !== undefined ? [lines] : []),
    'Read the reply before continuing. If the user asks a follow-up question or requests an explanation, answer it in the Task Thread with `ted comment`. If the original decision is still needed, ask it again with `ted comment --choice` or `ted outcome ask`. A request for explanation gives no consent; keep permission and sign-off decisions with their existing approval controls.',
  ].join('\n\n')
}
