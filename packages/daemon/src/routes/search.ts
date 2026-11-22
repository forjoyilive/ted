import { searchTerms } from '@ted/protocol'
import { searchConversations } from '../conversation-search.ts'
import { emptySearchResults, search } from '../search.ts'
import type { Route } from './route.ts'

const maxQueryLength = 500

export const searchRoutes: Route[] = [
  {
    method: 'GET',
    path: /^\/search(?:\?.*)?$/,
    async handle({ req }, { store, conversations }) {
      const params = new URL(req.url ?? '/', 'http://localhost').searchParams
      const factoryId = params.get('factory') ?? undefined
      const scope = params.get('scope')
      const request = {
        query: (params.get('q') ?? '').slice(0, maxQueryLength),
        ...(factoryId !== undefined && { factoryId }),
      }
      const tasks = searchTerms(request.query).length > 0 ? store.listTasks() : []
      const results =
        scope === 'conversations'
          ? emptySearchResults(request.query)
          : search(store, request, tasks)
      if (scope !== 'records') {
        results.conversations = await searchConversations(store, conversations, request, tasks)
      }
      return [200, results]
    },
  },
]
