import { integrationInstallPages } from '@ted/protocol'

export async function openIntegrationInstructions(
  url: string,
  openExternal: (url: string) => Promise<void>,
): Promise<void> {
  if (!Object.values(integrationInstallPages).some((page) => page === url)) {
    throw new Error('Unknown integration instructions page')
  }
  await openExternal(url)
}
