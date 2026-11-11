import { searchConversations } from '../conversation-search.ts'
import { search } from '../search.ts'
import type { Route } from './route.ts'

const maxQueryLength = 500

export const searchRoutes: Route[] = [
  {
    method: 'GET',
    path: /^\/search(?:\?.*)?$/,
    async handle({ req }, { store, conversations }) {
      const params = new URL(req.url ?? '/', 'http://localhost').searchParams
      const factoryId = params.get('factory') ?? undefined
      const request = {
        query: (params.get('q') ?? '').slice(0, maxQueryLength),
        ...(factoryId !== undefined && { factoryId }),
      }
      const results = search(store, request)
      results.conversations = await searchConversations(store, conversations, request)
      return [200, results]
    },
  },
]
