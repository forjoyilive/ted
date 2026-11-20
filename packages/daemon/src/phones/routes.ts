import type { Edition, PhoneRouteName, PhoneStatusBody } from '@ted/protocol'
import { phoneProtocolVersion } from '@ted/protocol'
import type { Caller } from '../tasks/tasks.ts'

export type PhoneCaller = Extract<Caller, { kind: 'phone' }>

export interface PhoneRouteContext {
  macName(): Promise<string>
  edition: Edition
  version: string
}

export interface PhoneRoute {
  name: PhoneRouteName
  handle(caller: PhoneCaller, context: PhoneRouteContext): Promise<PhoneStatusBody>
}

export const phoneRoutes: readonly PhoneRoute[] = [
  {
    name: 'status',
    async handle(_, { macName, edition, version }) {
      return { mac: await macName(), edition, version, protocol: phoneProtocolVersion }
    },
  },
]
