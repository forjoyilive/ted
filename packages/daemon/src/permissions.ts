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

const launches = new WeakMap<TedStore, Map<string, Promise<void>>>()

export async function acquireFactoryPermissions(
  store: TedStore,
  factoryId: string,
): Promise<() => void> {
  let pending = launches.get(store)
  if (!pending) {
    pending = new Map()
    launches.set(store, pending)
  }
  const previous = pending.get(factoryId)
  let unlock = () => {}
  const next = new Promise<void>((resolve) => {
    unlock = resolve
  })
  pending.set(factoryId, next)
  await previous
  let released = false
  return () => {
    if (released) return
    released = true
    if (pending.get(factoryId) === next) pending.delete(factoryId)
    unlock()
  }
}

export async function acquireRunPermissions(
  store: TedStore,
  run: { taskId?: string | undefined },
): Promise<() => void> {
  const task = run.taskId === undefined ? undefined : store.getTask(run.taskId)
  return task ? acquireFactoryPermissions(store, task.factoryId) : () => {}
}

export async function withRunPermissions<T>(
  store: TedStore,
  run: { taskId?: string | undefined },
  launch: () => Promise<T>,
): Promise<T> {
  const release = await acquireRunPermissions(store, run)
  try {
    return await launch()
  } finally {
    release()
  }
}
