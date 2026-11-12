import { parseLibraryChanges, parseSaveLibraryRequest } from '@ted/protocol'
import { jsonRoute, type Route } from './route.ts'

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
  jsonRoute(parseLibraryChanges, {
    method: 'POST',
    path: /^\/library\/preview$/,
    async handle({ body }, { library }) {
      return [200, await library.preview(body)]
    },
  }),
  jsonRoute(parseSaveLibraryRequest, {
    method: 'POST',
    path: /^\/library\/save$/,
    async handle({ body }, { library }) {
      return [200, await library.save(body)]
    },
  }),
]
