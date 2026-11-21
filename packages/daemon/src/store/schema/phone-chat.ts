import { Events, Schema, State } from '@livestore/livestore'
import { chatsEvents, chatsMaterializers } from './chats.ts'
import { phoneChatSends, phonesEvents, phonesMaterializers, phoneTaskCreateId } from './phones.ts'
import { plansEvents, plansMaterializers } from './plans.ts'
import { runsEvents, runsMaterializers } from './runs.ts'

const write = <Name extends string, Args>(event: { name: Name; schema: Schema.Codec<Args> }) =>
  Schema.Struct({ name: Schema.Literal(event.name), args: event.schema })

const phoneChatWrite = Schema.Union([
  write(chatsEvents.coordinatorChatChanged),
  write(chatsEvents.chatAgentRecorded),
  write(chatsEvents.chatAgentCommandsRecorded),
  write(chatsEvents.chatAgentOutsideCommandsRecorded),
  write(plansEvents.planStarted),
  write(plansEvents.planStartedFromTask),
  write(plansEvents.planRetried),
  write(plansEvents.planContinued),
  write(runsEvents.runMessageQueued),
  write(runsEvents.runMessageSent),
  write(runsEvents.runMessageFilesAttached),
])

export type PhoneChatWrite = typeof phoneChatWrite.Type

export const phoneChatEvents = {
  phoneChatCommitted: Events.synced({
    name: 'v1.PhoneChatCommitted',
    schema: Schema.Struct({
      sent: phonesEvents.phoneChatSent.schema,
      writes: Schema.Array(phoneChatWrite),
    }),
  }),
}

export const phoneChatMaterializers = State.SQLite.materializers(phoneChatEvents, {
  'v1.PhoneChatCommitted': ({ sent, writes }, context) => {
    const id = phoneTaskCreateId(sent.phoneId, sent.createId)
    if (context.query(phoneChatSends.where({ id }).first())) return []
    return [
      ...writes.flatMap((write) => {
        switch (write.name) {
          case 'v1.CoordinatorChatChanged':
            return chatsMaterializers[write.name](write.args, {
              ...context,
              eventDef: chatsEvents.coordinatorChatChanged,
            })
          case 'v1.ChatAgentRecorded':
            return chatsMaterializers[write.name](write.args, {
              ...context,
              eventDef: chatsEvents.chatAgentRecorded,
            })
          case 'v1.ChatAgentCommandsRecorded':
            return chatsMaterializers[write.name](write.args, {
              ...context,
              eventDef: chatsEvents.chatAgentCommandsRecorded,
            })
          case 'v1.ChatAgentOutsideCommandsRecorded':
            return chatsMaterializers[write.name](write.args, {
              ...context,
              eventDef: chatsEvents.chatAgentOutsideCommandsRecorded,
            })
          case 'v1.PlanStartedFromTask':
            return plansMaterializers[write.name](write.args, {
              ...context,
              eventDef: plansEvents.planStartedFromTask,
            })
          case 'v1.PlanStarted':
            return plansMaterializers[write.name](write.args, {
              ...context,
              eventDef: plansEvents.planStarted,
            })
          case 'v1.PlanRetried':
            return plansMaterializers[write.name](write.args, {
              ...context,
              eventDef: plansEvents.planRetried,
            })
          case 'v1.PlanContinued':
            return plansMaterializers[write.name](write.args, {
              ...context,
              eventDef: plansEvents.planContinued,
            })
          case 'v1.RunMessageQueued':
            return runsMaterializers[write.name](write.args, {
              ...context,
              eventDef: runsEvents.runMessageQueued,
            })
          case 'v1.RunMessageSent':
            return runsMaterializers[write.name](write.args, {
              ...context,
              eventDef: runsEvents.runMessageSent,
            })
          case 'v1.RunMessageFilesAttached':
            return runsMaterializers[write.name](write.args, {
              ...context,
              eventDef: runsEvents.runMessageFilesAttached,
            })
        }
        write satisfies never
        throw new Error('Unknown phone chat write')
      }),
      ...[
        phonesMaterializers['v1.PhoneChatSent'](sent, {
          ...context,
          eventDef: phonesEvents.phoneChatSent,
        }),
      ].flat(),
    ]
  },
})
