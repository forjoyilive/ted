import type { Comment, MachineSettings, Task, TrackerGroup } from '@ted/protocol'
import { RequestError } from '../../errors.ts'
import type { TedStore } from '../../store/index.ts'
import type { TrackerConnector, TrackerRecords } from './connector.ts'

export const allowChoice = 'Allow'
export const notNowChoice = 'Not now'

export interface TrackerConsent {
  tracker: string
  allowTask(ref: Task): Task | undefined
  askGroup(taskId: string, automationName: string, group: TrackerGroup | undefined): void
  allowGroup(factoryId: string, group: string): MachineSettings
  answerGroup(task: Task, comment: Comment, choice: string | undefined, text: string): Comment
  asks(comment: Comment): boolean
}

export function createTrackerConsent<Source, Handle>(
  store: TedStore,
  connector: TrackerConnector<Source, Handle>,
  records: TrackerRecords<Handle>,
): TrackerConsent {
  function openGroupAsks(factoryId: string, group: string): Comment[] {
    return store
      .listOpenRequests()
      .filter(
        (c) => records.askedGroup(c) === group && store.getTask(c.taskId)?.factoryId === factoryId,
      )
  }

  function allowGroup(factoryId: string, group: string): MachineSettings {
    const consents = store.listTasks().flatMap((task) => {
      if (task.factoryId !== factoryId || task.archived) return []
      if (records.syncState(task) !== 'ask') return []
      const source = task.source && connector.source(task.source.url)
      const seen = records.record(task.id).seen
      return source && seen?.group === group
        ? [{ taskId: task.id, label: connector.label(source) }]
        : []
    })
    const settings = records.allowGroup(factoryId, group, consents)
    closeGroupAsks(factoryId, group, allowChoice)
    return settings
  }

  function declineGroup(factoryId: string, group: string): void {
    records.declineGroup(factoryId, group)
    closeGroupAsks(factoryId, group, notNowChoice)
  }

  function closeGroupAsks(factoryId: string, group: string, choice: string): void {
    const at = new Date().toISOString()
    for (const ask of openGroupAsks(factoryId, group)) {
      store.answerComment(ask.id, { kind: 'answered', at, choice })
    }
  }

  return {
    tracker: connector.id,

    allowTask(task) {
      const source = task.source && connector.source(task.source.url)
      if (!source) return undefined
      if (records.syncState(task) !== 'on') records.allowTask(task, connector.label(source))
      return store.getTask(task.id) ?? task
    },

    askGroup(taskId, automationName, group) {
      const task = store.getTask(taskId)
      const factory = task && store.getFactory(task.factoryId)
      const source = task?.source && connector.source(task.source.url)
      if (!task || !factory || !source || !group || records.syncState(task) !== 'ask') return
      const settings = store.settings()
      if (!connector.enabled(settings)) return
      const lists = records.groups(settings, factory.id)
      if (lists.allowed.includes(group.key) || lists.declined.includes(group.key)) return
      if (openGroupAsks(factory.id, group.key).length > 0) return
      store.postComment({
        taskId,
        kind: 'question',
        author: { kind: 'ted' },
        title: connector.texts.groupTitle(group, factory.name),
        body: connector.texts.groupBody({
          automation: automationName,
          task: task.displayId,
          label: connector.label(source),
          group,
          factoryName: factory.name,
        }),
        choices: [allowChoice, notNowChoice],
        ...records.groupAsk(group),
      })
    },

    allowGroup,

    answerGroup(task, comment, choice, text) {
      if (comment.answer?.kind === 'withdrawn') {
        throw new RequestError(409, 'this request was withdrawn')
      }
      if (comment.answer) throw new RequestError(409, 'this request has already been answered')
      const group = records.askedGroup(comment)
      if (group === undefined) {
        throw new RequestError(
          400,
          `this question isn’t about a ${connector.name} ${connector.groupNoun}`,
        )
      }
      if (text !== '') {
        throw new RequestError(
          400,
          `answer with ${allowChoice} or ${notNowChoice}; this question doesn’t reach the Task Lead`,
        )
      }
      if (choice === allowChoice) allowGroup(task.factoryId, group)
      else if (choice === notNowChoice) declineGroup(task.factoryId, group)
      else throw new RequestError(400, `answer with ${allowChoice} or ${notNowChoice}`)
      return store.getComment(comment.id) ?? comment
    },

    asks(comment) {
      return records.isGroupAsk(comment)
    },
  }
}
