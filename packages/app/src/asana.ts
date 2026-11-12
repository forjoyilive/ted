import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { type DaemonClient, parseAsanaConfiguration } from '@ted/protocol'
import type { Dialog } from 'electron'

export async function importAsanaConfiguration(
  client: DaemonClient,
  dialog: Pick<Dialog, 'showOpenDialog'>,
  inFile = false,
) {
  if (typeof inFile !== 'boolean') throw new Error('Choose a credential storage option')
  const result = await dialog.showOpenDialog({
    title: 'Import private Asana app configuration',
    properties: ['openFile'],
    filters: [{ name: 'JSON configuration', extensions: ['json'] }],
  })
  const file = result.filePaths[0]
  if (result.canceled || !file) return client.getAsana()
  let configuration: ReturnType<typeof parseAsanaConfiguration>
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat()
      if (
        !info.isFile() ||
        info.size > 8192 ||
        info.nlink !== 1 ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw new Error()
      const data = JSON.parse(await handle.readFile('utf8')) as Record<string, unknown>
      configuration = parseAsanaConfiguration({
        clientId: data.client_id,
        clientSecret: data.client_secret,
        inFile,
      })
    } finally {
      await handle.close()
    }
  } catch {
    throw new Error(
      'Choose a private JSON file (permissions 0600) containing client_id and client_secret. Keep it outside repos and delete it after import.',
    )
  }
  return client.configureAsana(configuration)
}

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
