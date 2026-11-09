import { agentRoles, type LibraryChanges } from '@ted/protocol'
import { RequestError as HttpError } from '../errors.ts'
import { keepStageFiles, record, roleChoice, stageFiles, stageSettings } from './factories.ts'
import { type Route, readJson } from './route.ts'

export const libraryRoutes: Route[] = [
  {
    method: 'GET',
    path: /^\/library$/,
    handle: async (_, { library }) => [200, await library.view()],
  },
  {
    method: 'GET',
    path: /^\/drift$/,
    handle: async (_, { workflows }) => [200, workflows.drift()],
  },
  {
    method: 'POST',
    path: /^\/library\/preview$/,
    async handle({ req }, { library }) {
      return [200, await library.preview(libraryChanges(await readJson(req)))]
    },
  },
  {
    method: 'POST',
    path: /^\/library\/save$/,
    async handle({ req }, { library }) {
      const body = record(await readJson(req))
      if (typeof body.version !== 'string') throw new HttpError(400, 'version is required')
      return [
        200,
        await library.save({ changes: libraryChanges(body.changes), version: body.version }),
      ]
    },
  },
]

function libraryChanges(given: unknown): LibraryChanges {
  const body = record(given)
  const changes: LibraryChanges = {}
  if (body.stages !== undefined) changes.stages = stageSettings(body.stages)
  if (body.stageFiles !== undefined) changes.stageFiles = stageFiles(body.stageFiles)
  if (body.keepStageFiles !== undefined) {
    changes.keepStageFiles = keepStageFiles(body.keepStageFiles)
  }
  if (body.agents !== undefined) {
    const agents = record(body.agents)
    changes.agents = {}
    for (const role of agentRoles) {
      if (agents[role] !== undefined) changes.agents[role] = roleChoice(agents[role], role)
    }
  }
  return changes
}
