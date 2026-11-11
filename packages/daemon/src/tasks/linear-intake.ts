import { parseLinearUrl } from '@ted/protocol'
import { RequestError } from '../errors.ts'
import type { Linear } from '../linear/linear.ts'
import type { TedStore } from '../store/index.ts'

export async function verifyLinearIntake(
  store: Pick<TedStore, 'settings'>,
  linear: Partial<Pick<Linear, 'intakeMembership'>> | undefined,
  factoryId: string,
  url: string | undefined,
): Promise<() => void> {
  const link = url === undefined ? undefined : parseLinearUrl(url)
  if (!link) return () => undefined
  const scope = store.settings().linearIntakeScopes[factoryId]
  const unchanged = () => {
    if (JSON.stringify(store.settings().linearIntakeScopes[factoryId]) !== JSON.stringify(scope)) {
      throw new RequestError(
        409,
        'The Factory’s Linear intake scope changed. Try creating the Task again.',
      )
    }
  }
  if (!scope) return unchanged
  if (!linear?.intakeMembership) {
    throw new RequestError(
      409,
      'Couldn’t verify the Factory’s Linear intake scope. Connect Linear in App Settings → Integrations and try again.',
    )
  }
  const membership = await linear.intakeMembership(link)
  unchanged()
  if (
    link.workspace !== scope.workspace ||
    membership.workspace !== scope.workspace ||
    membership.workspaceId !== scope.workspaceId ||
    (scope.kind === 'team' ? membership.teamId : membership.projectId) !== scope.id
  ) {
    throw new RequestError(
      409,
      `${link.identifier} is outside this Factory’s Linear intake scope (${scope.kind}: ${scope.name}). Leave it for another Factory or import it manually.`,
    )
  }
  return unchanged
}
