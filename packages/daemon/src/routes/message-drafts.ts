import {
  type MessageBox,
  type MessageDraftState,
  parseMessageBox,
  parseSaveMessageDraftRequest,
} from '@ted/protocol'
import { RequestError as HttpError } from '../errors.ts'
import type { TedStore } from '../store/index.ts'
import { jsonRoute, type Route } from './route.ts'

interface Owner {
  box: MessageBox
  factoryId?: string
  taskId?: string
  planId?: string
}

export function messageDraftOwner(store: TedStore, box: MessageBox): Owner {
  const openTask = (ref: string) => {
    const task = store.getTask(ref)
    if (!task) throw new HttpError(404, 'no such Task')
    if (task.archived) throw new HttpError(409, 'an archived Task keeps no unsent text')
    return task
  }
  switch (box.kind) {
    case 'comment':
    case 'follow-up': {
      const task = openTask(box.id)
      return { box: { kind: box.kind, id: task.id }, factoryId: task.factoryId, taskId: task.id }
    }
    case 'request': {
      const comment = store.getComment(box.id)
      if (!comment || comment.kind === 'note') throw new HttpError(404, 'no such request')
      if (comment.answer) throw new HttpError(409, 'this request is already answered')
      const task = openTask(comment.taskId)
      return { box, factoryId: task.factoryId, taskId: task.id }
    }
    case 'plan-request': {
      const request = store.plans.request(box.id)
      if (!request || request.kind === 'note') throw new HttpError(404, 'no such request')
      if (request.answer) throw new HttpError(409, 'this request is already answered')
      const factoryId = store.plans.get(request.planId)?.factoryId
      return { box, planId: request.planId, ...(factoryId !== undefined && { factoryId }) }
    }
    case 'run': {
      const run = store.getRun(box.id)
      if (!run) throw new HttpError(404, 'no such Run')
      const task = run.taskId === undefined ? undefined : openTask(run.taskId)
      const plan = store.plans.get(run.id)
      const firing = store.automations.firing(run.id)
      const factoryId =
        task?.factoryId ??
        plan?.factoryId ??
        store.coordinators.forRun(run.id)?.factoryId ??
        (firing && store.automations.get(firing.automationId)?.factoryId)
      return {
        box,
        ...(task && { taskId: task.id }),
        ...(plan && { planId: plan.id }),
        ...(factoryId !== undefined && { factoryId }),
      }
    }
    case 'coordinator': {
      const chat = store.coordinators.find(box.id)
      if (!chat || !store.getFactory(chat.factoryId))
        throw new HttpError(404, 'no such Coordinator chat')
      return { box, factoryId: chat.factoryId }
    }
    case 'coordinator-request': {
      const request = store.chats.request(box.id)
      if (!request) throw new HttpError(404, 'no such request')
      if (request.answer) throw new HttpError(409, 'this request is already answered')
      const chat = store.coordinators.find(request.chatId)
      if (!chat || !store.getFactory(chat.factoryId)) throw new HttpError(404, 'no such request')
      return { box, factoryId: chat.factoryId }
    }
    case 'coordinator-new':
    case 'new-plan':
    case 'agent-prompt':
      if (!store.getFactory(box.id)) throw new HttpError(404, 'no such Factory')
      return { box, factoryId: box.id }
  }
}

const path = /^\/message-drafts\/([^/]+)\/([^/]+)$/

export const messageDraftRoutes: Route[] = [
  {
    method: 'GET',
    path,
    handle: async ({ params: [kind = '', id = ''], caller }, { store }) => {
      if (caller.kind !== 'app') throw new HttpError(403, 'only the Ted app can read unsent text')
      const box = parseMessageBox(kind, id)
      const task =
        box.kind === 'comment' || box.kind === 'follow-up' ? store.getTask(id) : undefined
      const state: MessageDraftState = {
        draft: store.messageDraft(task ? { kind: box.kind, id: task.id } : box),
      }
      return [200, state]
    },
  },
  jsonRoute(parseSaveMessageDraftRequest, {
    method: 'PUT',
    path,
    handle: async ({ body, params: [kind = '', id = ''] }, { store, attachments }) => {
      const asked = parseMessageBox(kind, id)
      const files =
        asked.kind === 'comment'
          ? await Promise.all(body.attachments.map((file) => attachments.find(file)))
          : []
      let found: Owner
      try {
        found = messageDraftOwner(store, asked)
      } catch (error) {
        if (!(error instanceof HttpError)) throw error
        const refused: MessageDraftState = { draft: null, refused: error.message }
        return [200, refused]
      }
      const { box, ...owner } = found
      const state: MessageDraftState = {
        draft: store.saveMessageDraft(box, owner, {
          text: body.text,
          attachments: files,
          ...(body.fields !== undefined && { fields: body.fields }),
        }),
      }
      return [200, state]
    },
  }),
]
