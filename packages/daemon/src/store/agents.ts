import { queryDb } from '@livestore/livestore'
import type { PeerMessage } from '@ted/protocol'
import type { ChatStore } from './chats.ts'
import type { StoreContext } from './context.ts'
import type { CoordinatorStore } from './coordinators.ts'
import { createPlanStore, type PlanStore } from './plans.ts'
import { events, peerMessages, tasks } from './schema.ts'
import { createSideChatStore, type SideChatStore } from './side-chats.ts'
import type { StoredTask } from './types.ts'

export interface AgentsArea {
  coordinatorCreated(factoryId: string, operation: string): StoredTask | undefined
  isPeerMessage(id: string): boolean
  peerMessages(): PeerMessage[]
  recordPeerMessage(
    input: Omit<PeerMessage, 'id' | 'createdAt' | 'delivered'>,
    body: string,
  ): PeerMessage
  sideChats: SideChatStore
  coordinators: CoordinatorStore
  chats: ChatStore
  plans: PlanStore
}

export function agentsArea(ctx: StoreContext): AgentsArea {
  const {
    store,
    commit,
    toTask,
    taskRow,
    emit,
    getComment,
    requireComment,
    commentPosted,
    updatedTask,
    noteActivity,
    coordinatorStore,
    chatStore,
  } = ctx
  const planStore = createPlanStore({
    store,
    commit,
    emit,
    changed: () => noteActivity(),
    taskChanged: (taskId) => {
      if (taskRow(taskId)) updatedTask(taskId)
    },
  })

  return {
    sideChats: createSideChatStore({
      store,
      commit,
      changed(sourceRunId) {
        emit({ type: 'side-chat-changed', sourceRunId })
        noteActivity()
      },
    }),
    isPeerMessage: (id) => store.query(queryDb(peerMessages.where({ id }))).length > 0,
    peerMessages() {
      return store.query(queryDb(peerMessages)).map((row) => {
        const delivered = getComment(row.id)?.delivered
        return { ...row, ...(delivered && { delivered }) }
      })
    },
    recordPeerMessage(input, body) {
      const createdAt = new Date().toISOString()
      const { id, event } = commentPosted(
        {
          taskId: input.recipientTaskId,
          body,
          author: { kind: 'run', runId: input.senderRunId },
        },
        createdAt,
      )
      const row = { ...input, id, createdAt }
      commit(event, events.peerMessageSent(row))
      emit({ type: 'comment-posted', comment: requireComment(id) })
      return row
    },
    coordinators: coordinatorStore,
    chats: chatStore,
    plans: planStore,
    coordinatorCreated(factoryId, operation) {
      const row = store
        .query(queryDb(tasks.where({ factoryId, coordinatorOperation: operation })))
        .at(0)
      return row && toTask(row)
    },
  }
}
