import { search } from '../search.ts'
import type { Route } from './route.ts'

const maxQueryLength = 500

export const searchRoutes: Route[] = [
  {
    method: 'GET',
    path: /^\/search(?:\?.*)?$/,
    async handle({ req }, { store }) {
      const params = new URL(req.url ?? '/', 'http://localhost').searchParams
      const factoryId = params.get('factory') ?? undefined
      return [
        200,
        search(store, {
          query: (params.get('q') ?? '').slice(0, maxQueryLength),
          ...(factoryId !== undefined && { factoryId }),
        }),
      ]
    },
  },
]
