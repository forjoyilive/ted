import type { PermissionMode } from '@ted/protocol'
import type { Banners } from './banners.ts'
import type { TedStore } from './store/index.ts'

export function factoryPermissions(store: TedStore, factoryId: string): PermissionMode {
  return store.settings().factoryPermissions[factoryId] === 'bypass' ? 'bypass' : 'auto'
}

export function runPermissions(
  store: TedStore,
  run: { taskId?: string | undefined },
): PermissionMode {
  const task = run.taskId === undefined ? undefined : store.getTask(run.taskId)
  return task ? factoryPermissions(store, task.factoryId) : 'auto'
}

export function reportRepoPermissions(
  store: TedStore,
  banners: Banners,
  factoryId: string,
  repoMode: string | undefined,
): void {
  const ref = { problem: 'repo-requests-bypass', factoryId }
  if (repoMode !== 'bypass' || factoryPermissions(store, factoryId) === 'bypass') {
    banners.clear(ref)
    return
  }
  banners.raise({
    ...ref,
    severity: 'warning',
    text: 'The repo requests Bypass · this computer uses Auto until you enable Bypass in Factory settings',
    action: { label: 'Open Factory settings', opens: { kind: 'factory-settings', factoryId } },
  })
}
