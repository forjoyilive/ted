import {
  type AnswerRequest,
  type ClarifyDepth,
  type Comment,
  joinChoices,
  type Round,
  type RoundAnswer,
  type RoundAnswerInput,
  type RoundQuestion,
  sameChoices,
} from '@ted/protocol'
import { RequestError } from '../errors.ts'

export const depthOrder: readonly ClarifyDepth[] = ['none', 'few', 'grilling']

export const depthNames: Record<ClarifyDepth, string> = {
  auto: 'Auto',
  none: 'None',
  few: 'Few',
  grilling: 'Grill',
}

export const pickDepth = 'ted clarify depth <none|few|grilling> "<why>"'

export const clarifySignoffCaption =
  'Approve moves the Task on. Request changes starts another round.'

export function roundAnswers(round: Round, request: AnswerRequest): RoundAnswer[] {
  if (request.action === 'accept-recommended') {
    return round.questions.map((q) => ({
      answer: q.recommended,
      ...(q.multiple && { choices: q.recommendedChoices ?? [] }),
      changed: false,
    }))
  }
  if (request.action !== 'answer-round') {
    throw new RequestError(400, 'answer a round with Submit answers or Accept all recommended')
  }
  const { questions } = round
  if (request.answers.length !== questions.length) {
    throw new RequestError(400, `answer all ${questions.length} questions`)
  }
  return questions.map((question, i) => answerTo(question, i + 1, request.answers[i]))
}

function answerTo(
  question: RoundQuestion,
  number: number,
  given: RoundAnswerInput | undefined,
): RoundAnswer {
  if (question.multiple) return severalAnswerTo(question, number, given)
  const answer = given?.answer.trim() ?? ''
  const note = given?.note?.trim() ?? ''
  if (answer === '') throw new RequestError(400, `question ${number} needs an answer`)
  return {
    answer,
    ...(note !== '' && { note }),
    changed: answer !== question.recommended.trim(),
  }
}

function severalAnswerTo(
  question: RoundQuestion,
  number: number,
  given: RoundAnswerInput | undefined,
): RoundAnswer {
  const offered = question.choices ?? []
  const picks = offered.filter((c) => given?.choices?.includes(c))
  if ((given?.choices ?? []).some((c) => !offered.includes(c))) {
    throw new RequestError(400, `question ${number}’s answers must be among its choices`)
  }
  const other = given?.answer.trim() ?? ''
  const note = given?.note?.trim() ?? ''
  if (picks.length === 0 && other === '') {
    throw new RequestError(400, `question ${number} needs at least one answer`)
  }
  return {
    answer: joinChoices([...picks, ...(other !== '' ? [other] : [])]),
    choices: picks,
    ...(note !== '' && { note }),
    changed: other !== '' || !sameChoices(picks, question.recommendedChoices ?? []),
  }
}

export function roundAnswerMessage(
  request: Comment,
  answers: readonly RoundAnswer[],
  depth: ClarifyDepth,
): string {
  const round = request.round
  const lines = (round?.questions ?? []).map((question, i) => {
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
    `The human answered Round ${round?.number ?? ''} “${request.title ?? ''}”:`,
    lines.join('\n'),
    nextAfterRound(depth),
  ].join('\n\n')
}

export function roundAnswerSummary(request: Comment, answers: readonly RoundAnswer[]): string {
  const questions = request.round?.questions ?? []
  return answers
    .map((answer, i) => {
      const question = questions[i]
      const tag =
        answer.changed && question
          ? `changed from your recommendation “${question.recommended}”`
          : answer.changed
            ? 'changed'
            : 'recommended'
      const note = answer.note === undefined ? '' : `; note: ${answer.note}`
      return `${i + 1}. ${question?.question ?? ''} → ${answer.answer} (${tag}${note})`
    })
    .join(' ')
}

function nextAfterRound(depth: ClarifyDepth): string {
  if (depth === 'grilling') {
    return 'If anything is still open, ask another round with `ted ask --round <file>`. When nothing is, write the Task brief with every decision under Decisions so far, then run `ted outcome advance`. TED requests sign-off if the effective Clarify sign-off setting is on; otherwise it moves the Task on.'
  }
  return 'Clarify depth is Few, so this was the only round. Write the decisions into the Task brief’s Decisions so far with `ted brief write`, then run `ted outcome advance`. If an answer raises something bigger, switch to grilling with `ted clarify depth grilling "<why>"` and ask another round.'
}
