import type { DaemonClient } from '@ted/protocol'

export async function authorizeAsana(
  client: DaemonClient,
  openExternal: (url: string) => Promise<void>,
) {
  const { url } = await client.connectAsana()
  const parsed = new URL(url)
  if (
    parsed.origin !== 'https://app.asana.com' ||
    parsed.pathname !== '/-/oauth_authorize' ||
    parsed.username ||
    parsed.password
  ) {
    await client.cancelAsana()
    throw new Error('Invalid Asana authorization destination')
  }
  try {
    await openExternal(url)
  } catch {
    await client.cancelAsana()
    throw new Error('Couldn’t open your browser. Connect to try again.')
  }
  return client.getAsana()
}
