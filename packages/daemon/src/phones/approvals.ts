import { createHash } from 'node:crypto'
import type {
  ChatRequest,
  Comment,
  CoordinatorConfirmation,
  PhoneApproval,
  PhoneApprovalTask,
  TaskMovePlan,
} from '@ted/protocol'
import {
  localFolderCardAction,
  localFolderCardText,
  repoShortName,
} from '@ted/protocol/local-folder'
import { shownOutsideCommand } from '@ted/protocol/outside-command'
import {
  keepMoveChoice,
  moveChoice,
  movePlanKept,
  movePlanKey,
  movePlanView,
} from '@ted/protocol/task-move'
import { outsideApprovalRevision } from '../chats/outside-commands.ts'
import { RequestError } from '../errors.ts'
import { redactSecrets } from '../redact.ts'
import type { TedStore } from '../store/index.ts'
import type { Tasks } from '../tasks/tasks.ts'
import { stageTitle } from '../workflow/workflow.ts'
import { jsonBytes } from './fit.ts'

type Confirmation = Extract<PhoneApproval, { kind: 'confirmation' }>

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

const label = ({ displayId, title }: { displayId: string; title: string }) =>
  redactSecrets(`${displayId} · ${title}`)

export function phoneMoveRevision(plan: TaskMovePlan): string {
  return digest(movePlanKey(plan))
}

export function phoneApprovalFits(approval: PhoneApproval): boolean {
  return jsonBytes(approval) <= 36_000
}

export function confirmationApproval(
  chatId: string,
  title: string,
  card: CoordinatorConfirmation,
): Confirmation {
  return {
    kind: 'confirmation',
    operation: card.kind,
    chatId,
    title: redactSecrets(title),
    tasks: card.tasks.map((task) => ({
      id: task.id,
      label: label(task),
      working: task.working,
      descendants: task.descendants.map(label),
      blocked: task.blockedTasks.map(label),
      blockedTogether: (task.blockedTogether ?? task.blockedTasks).map(label),
      pullRequests: task.pullRequests.map(({ repo, number }) =>
        redactSecrets(`${repo} #${number}`),
      ),
      ...(task.children !== undefined && { children: task.children }),
      ...(task.closePullRequests !== undefined && { closePullRequests: task.closePullRequests }),
      ...(task.result && { result: redactSecrets(task.result.text) }),
    })),
    warnings: card.transfer ? moveWarnings(card.transfer) : [],
    ...(card.transfer?.refusal !== undefined && { refusal: redactSecrets(card.transfer.refusal) }),
    ...(card.answer && { decision: card.answer.decision }),
  }
}

function moveWarnings(plan: TaskMovePlan): string[] {
  const view = movePlanView(plan, stageTitle)
  if (!view) return []
  const { before, newDisplayId, after } = view.landing
  return [
    `${before}${newDisplayId}${after}`,
    ...view.movesWith.map((task) => `Moves with it: ${label(task)} · ${task.note}`),
    ...(view.leavesParent === undefined ? [] : [view.leavesParent]),
    ...view.unlinked.map((task) => `Blocker link removed: ${label(task)} · ${task.note}`),
    ...view.changes,
    movePlanKept,
  ].map(redactSecrets)
}

export function moveApproval(
  chatId: string,
  title: string,
  task: Pick<PhoneApprovalTask, 'id' | 'label' | 'working' | 'result'>,
  plan?: TaskMovePlan,
  decision?: Confirmation['decision'],
  refusal?: string,
): Confirmation {
  return {
    kind: 'confirmation',
    operation: 'transfer',
    chatId,
    title: redactSecrets(title),
    tasks: [
      {
        ...task,
        label: redactSecrets(task.label),
        descendants: [],
        blocked: [],
        blockedTogether: [],
        pullRequests: [],
      },
    ],
    warnings: plan ? moveWarnings(plan) : [],
    ...(plan && { revision: phoneMoveRevision(plan) }),
    ...(decision !== undefined && { decision }),
    ...(refusal !== undefined && { refusal: redactSecrets(refusal) }),
  }
}

export function outsideApproval(chatId: string, request: ChatRequest): PhoneApproval | undefined {
  const ask = request.outsideCommand
  if (request.kind !== 'outside-command' || !ask) return undefined
  const local = ask.localFolder
  const action = local ? localFolderCardAction(local, ask.folder).kind : 'run'
  const status = local && localFolderCardText(local, ask.folder, repoShortName(ask.repo))
  const warnings = [
    ...(ask.allowedButHeld
      ? ['You allowed this command always. Ted asks again because the folder is out of date.']
      : []),
    ...(ask.allowedBefore !== undefined
      ? [`The command changed since you allowed it: ${ask.allowedBefore}`]
      : []),
    ...(ask.allowedFolder !== undefined
      ? [`The folder changed since you allowed it: ${ask.allowedFolder}`]
      : []),
    ...(status
      ? [status.text, status.detail, status.fix].filter((line) => line !== undefined)
      : []),
  ].map(redactSecrets)
  const answer = request.answer
  return {
    kind: 'outside-command',
    chatId,
    title: redactSecrets(`Run ${ask.name} outside the sandbox?`),
    command: redactSecrets(shownOutsideCommand(ask.command, ask.argument)),
    ...(ask.argument !== undefined && { argument: redactSecrets(ask.argument) }),
    repo: redactSecrets(ask.repo),
    folder: redactSecrets(ask.folder),
    warnings,
    runLabel: action === 'update' ? 'Update and run' : action === 'hold' ? 'Run anyway' : 'Run',
    canAlways: !ask.allowedButHeld,
    revision: outsideApprovalRevision(ask),
    ...(answer && {
      result:
        answer.kind === 'approved'
          ? redactSecrets(answer.text ?? 'Approved')
          : answer.kind === 'denied'
            ? 'Declined'
            : 'Withdrawn',
    }),
  }
}

export function phoneMoveApprovals(
  store: TedStore,
  tasks: Pick<Tasks, 'movePlan' | 'answerFromPhone'>,
) {
  async function read(comment: Comment): Promise<Confirmation | undefined> {
    const ask = comment.move
    if (ask?.askedBy !== 'coordinator' || ask.chatId === undefined) return undefined
    const task = store.getTask(comment.taskId)
    if (!task) return undefined
    const title = comment.title ?? 'Move Task?'
    const row = {
      id: task.id,
      label: label(task),
      working: task.runs.some((run) => run.role === 'lead' && run.state !== 'finished'),
    }
    if (comment.answer) {
      const moved = comment.answer.kind === 'answered' && comment.answer.choice === moveChoice
      return moveApproval(
        ask.chatId,
        title,
        moved && task.factoryId === ask.factoryId
          ? { ...row, result: `Moved as ${task.displayId}.` }
          : row,
        undefined,
        moved ? 'confirm' : 'cancel',
      )
    }
    try {
      const plan = await tasks.movePlan(task.id, ask.factoryId, comment.id)
      return moveApproval(ask.chatId, title, row, plan, undefined, plan.refusal)
    } catch (error) {
      if (!(error instanceof RequestError)) throw error
      return moveApproval(ask.chatId, title, row, undefined, undefined, error.message)
    }
  }

  async function answer(comment: Comment, decision: 'confirm' | 'cancel', revision?: string) {
    const ask = comment.move
    if (ask?.askedBy !== 'coordinator') throw new RequestError(404, 'No such move confirmation.')
    if (comment.answer) throw new RequestError(409, 'This confirmation was already answered.')
    if (decision === 'cancel') {
      await tasks.answerFromPhone(comment.id, { action: 'answer', choice: keepMoveChoice })
      return
    }
    const plan = await tasks.movePlan(comment.taskId, ask.factoryId, comment.id)
    if (plan.refusal !== undefined) throw new RequestError(409, plan.refusal)
    if (revision !== phoneMoveRevision(plan)) {
      const task = plan.tasks[0]?.displayId ?? 'The Task'
      throw new RequestError(
        409,
        `${task} or a Task under it changed since the move was shown, so nothing was moved. Look at the move again.`,
      )
    }
    await tasks.answerFromPhone(comment.id, {
      action: 'answer',
      choice: moveChoice,
      move: { factoryId: ask.factoryId, planKey: movePlanKey(plan) },
    })
  }

  return { read, answer }
}
