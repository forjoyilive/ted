import type { Comment, MachineSettings, Task } from '@ted/protocol'
import { parseLinearUrl } from '@ted/protocol'
import { RequestError } from '../errors.ts'
import type { TedStore } from '../store/index.ts'

const linearAllowChoice = 'Allow'
const linearNotNowChoice = 'Not now'

export function createLinearConsent(store: TedStore) {
  function openTeamAsks(factoryId: string, team: string): Comment[] {
    return store
      .listOpenRequests()
      .filter(
        (c) =>
          c.purpose?.kind === 'linear-team' &&
          c.linearTeam?.key === team &&
          store.getTask(c.taskId)?.factoryId === factoryId,
      )
  }

  function allowLinearTeam(factoryId: string, team: string): MachineSettings {
    const consents = store.listTasks().flatMap((task) => {
      if (task.factoryId !== factoryId || task.archived || task.linearSync !== 'ask') return []
      const link = task.source && parseLinearUrl(task.source.url)
      const seen = store.linearSync(task.id).seen
      return link && seen?.team === team ? [{ taskId: task.id, identifier: link.identifier }] : []
    })
    const settings = store.allowLinearTeam(factoryId, team, consents)
    closeTeamAsks(factoryId, team, linearAllowChoice)
    return settings
  }

  function declineLinearTeam(factoryId: string, team: string): void {
    const declined = store.settings().linearSyncDeclined
    const listed = declined[factoryId] ?? []
    if (!listed.includes(team)) {
      store.updateSettings({ linearSyncDeclined: { ...declined, [factoryId]: [...listed, team] } })
    }
    closeTeamAsks(factoryId, team, linearNotNowChoice)
  }

  function answerLinearTeam(
    task: Task,
    comment: Comment,
    choice: string | undefined,
    text: string,
  ): Comment {
    if (comment.answer?.kind === 'withdrawn') {
      throw new RequestError(409, 'this request was withdrawn')
    }
    if (comment.answer) throw new RequestError(409, 'this request has already been answered')
    const team = comment.linearTeam?.key
    if (team === undefined) throw new RequestError(400, 'this question isn’t about a Linear team')
    if (text !== '') {
      throw new RequestError(
        400,
        `answer with ${linearAllowChoice} or ${linearNotNowChoice}; this question doesn’t reach the Task Lead`,
      )
    }
    if (choice === linearAllowChoice) allowLinearTeam(task.factoryId, team)
    else if (choice === linearNotNowChoice) declineLinearTeam(task.factoryId, team)
    else throw new RequestError(400, `answer with ${linearAllowChoice} or ${linearNotNowChoice}`)
    return store.getComment(comment.id) ?? comment
  }

  function closeTeamAsks(factoryId: string, team: string, choice: string): void {
    const at = new Date().toISOString()
    for (const ask of openTeamAsks(factoryId, team)) {
      store.answerComment(ask.id, { kind: 'answered', at, choice })
    }
  }

  return { allowLinearTeam, openTeamAsks, answerLinearTeam }
}
