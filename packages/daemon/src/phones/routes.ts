import type { Edition, PhoneRequest, PhoneRouteName } from '@ted/protocol'
import { phoneProtocolVersion } from '@ted/protocol'
import type { Caller } from '../tasks/tasks.ts'
import type { PhoneOutcome, PhoneRequests } from './requests.ts'

export type PhoneCaller = Extract<Caller, { kind: 'phone' }>

export type PhoneRouteRequest = Extract<PhoneRequest, { type: 'request' }>

export interface PhoneRouteContext {
  macName(): Promise<string>
  edition: Edition
  version: string
  requests: PhoneRequests
}

export interface PhoneRoute {
  name: PhoneRouteName
  handle(
    caller: PhoneCaller,
    request: PhoneRouteRequest,
    context: PhoneRouteContext,
  ): Promise<PhoneOutcome>
}

export const phoneRoutes: readonly PhoneRoute[] = [
  {
    name: 'status',
    async handle(_, __, { macName, edition, version }) {
      return { body: { mac: await macName(), edition, version, protocol: phoneProtocolVersion } }
    },
  },
  {
    name: 'requests',
    async handle(_, __, { requests }) {
      return requests.list()
    },
  },
  {
    name: 'request',
    async handle(_, request, { requests }) {
      if (request.requestId === undefined) return { code: 'bad-request' }
      return requests.read(request.requestId)
    },
  },
  {
    name: 'answer',
    async handle(_, request, { requests }) {
      if (request.requestId === undefined || request.answer === undefined)
        return { code: 'bad-request' }
      return requests.answer(request.requestId, request.answer)
    },
  },
]
