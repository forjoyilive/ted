import type { DaemonClient, MachineSettings, TaskApp } from '@ted/protocol'
import type { api } from '../helpers.ts'

export async function approveAppsOutsideSandbox(
  client: Pick<DaemonClient, 'listApps' | 'getSettings' | 'updateSettings'>,
  task: { id: string; factoryId: string },
  only?: readonly string[],
): Promise<void> {
  const approvals = (await client.listApps(task.id))
    .filter((a) => only === undefined || only.includes(a.name))
    .flatMap((a) => a.outsideSandboxApproval ?? [])
  const { appsOutsideSandbox } = await client.getSettings()
  await client.updateSettings({
    appsOutsideSandbox: {
      ...appsOutsideSandbox,
      [task.factoryId]: [...(appsOutsideSandbox[task.factoryId] ?? []), ...approvals],
    },
  })
}

export async function approveAppsOutsideSandboxBy(
  client: Pick<ReturnType<typeof api>, 'call'>,
  task: { id: string; factoryId: string },
): Promise<void> {
  await approveAppsOutsideSandbox(
    {
      listApps: async (ref) =>
        (await client.call('GET', `/tasks/${encodeURIComponent(ref)}/apps`)).body as TaskApp[],
      getSettings: async () => (await client.call('GET', '/settings')).body as MachineSettings,
      updateSettings: async (changes) =>
        (await client.call('PATCH', '/settings', changes)).body as MachineSettings,
    },
    task,
  )
}
