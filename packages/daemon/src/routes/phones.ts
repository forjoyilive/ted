import { parsePhonePairingDecision } from '@ted/protocol'
import { jsonRoute, type Route } from './route.ts'

export const phoneAppRoutes: Route[] = [
  {
    method: 'POST',
    path: /^\/phones\/pairings$/,
    appOnly: true,
    handle: async (_, { phones }) => [201, await phones.createPairing()],
  },
  {
    method: 'GET',
    path: /^\/phones\/pairings\/current$/,
    appOnly: true,
    handle: async (_, { phones }) => [200, phones.current()],
  },
  {
    method: 'DELETE',
    path: /^\/phones\/pairings\/current$/,
    appOnly: true,
    handle: async (_, { phones }) => [200, phones.cancel()],
  },
  jsonRoute(parsePhonePairingDecision, {
    method: 'POST',
    path: /^\/phones\/pairings\/current\/approve$/,
    appOnly: true,
    handle: async ({ body }, { phones }) => [200, phones.approve(body.pairing)],
  }),
  jsonRoute(parsePhonePairingDecision, {
    method: 'POST',
    path: /^\/phones\/pairings\/current\/refuse$/,
    appOnly: true,
    handle: async ({ body }, { phones }) => [200, phones.refuse(body.pairing)],
  }),
  {
    method: 'GET',
    path: /^\/phones$/,
    appOnly: true,
    handle: async (_, { phones }) => [200, phones.list()],
  },
  {
    method: 'DELETE',
    path: /^\/phones\/([A-Za-z0-9-]{1,64})$/,
    appOnly: true,
    handle: async ({ params: [id] }, { phones }) => [200, phones.remove(id ?? '')],
  },
]
