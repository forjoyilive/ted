import { queryDb, type Store } from '@livestore/livestore'
import type { ExecutionEndpoint, ExecutionGrant } from '@ted/protocol'
import { events, executionPairing, type schema } from './schema.ts'

export function createPairingStore(
  store: Store<typeof schema>,
  commit: Store<typeof schema>['commit'],
) {
  const rows = () => store.query(queryDb(executionPairing))
  return {
    endpoint(): ExecutionEndpoint | undefined {
      const row = rows().find((r) => r.id === 'controller')
      return row && (JSON.parse(row.data) as ExecutionEndpoint)
    },
    configure(endpoint: ExecutionEndpoint) {
      commit(events.executionControllerConfigured({ data: JSON.stringify(endpoint) }))
    },
    grants(): ExecutionGrant[] {
      return rows()
        .filter((r) => r.id !== 'controller')
        .map((r) => JSON.parse(r.data) as ExecutionGrant)
    },
    approve(grant: ExecutionGrant) {
      commit(events.executionMachineApproved({ id: grant.id, data: JSON.stringify(grant) }))
    },
    forgetFactory(factoryId: string) {
      for (const grant of this.grants())
        if (grant.scopes.some((s) => s.factoryId === factoryId))
          commit(
            events.executionMachineRevoked({
              id: grant.id,
              data: JSON.stringify({
                ...grant,
                revokedAt: grant.revokedAt ?? new Date().toISOString(),
                scopes: grant.scopes.filter((s) => s.factoryId !== factoryId),
              }),
            }),
          )
    },
    revoke(id: string) {
      const row = rows().find((r) => r.id === id)
      if (!row) throw new Error('No such execution machine')
      const grant = JSON.parse(row.data) as ExecutionGrant
      commit(
        events.executionMachineRevoked({
          id,
          data: JSON.stringify({ ...grant, revokedAt: new Date().toISOString() }),
        }),
      )
    },
  }
}
export type PairingStore = ReturnType<typeof createPairingStore>
