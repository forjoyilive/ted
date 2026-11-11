import { prepareElectron } from './electron-installation.ts'

export default async function setup(): Promise<void> {
  await prepareElectron()
}
