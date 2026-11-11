import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

export async function installedElectron(): Promise<string> {
  const directory = path.dirname(createRequire(import.meta.url).resolve('electron/package.json'))
  const relative = await readFile(path.join(directory, 'path.txt'), 'utf8').catch(() => '')
  if (!relative.trim()) throw new Error('Install the Electron binary before launching the demo.')
  const executable = path.join(directory, 'dist', relative.trim())
  await access(executable, constants.X_OK).catch(() => {
    throw new Error(
      'Install the Electron binary before launching the demo. Demo startup never downloads it.',
    )
  })
  return executable
}
