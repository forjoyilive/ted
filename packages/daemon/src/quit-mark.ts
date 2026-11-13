import { lstatSync } from 'node:fs'
import path from 'node:path'
import { tedPaths } from '@ted/protocol'

export class QuitMarkedError extends Error {
  constructor() {
    super('TED was quit; not starting until the app opens again')
  }
}

export function quitMarkedSync(home: string): boolean {
  try {
    return lstatSync(tedPaths(home).quitMark).isFile()
  } catch {
    return false
  }
}

export const homeOfRunDir = (runDir: string) => path.dirname(path.dirname(path.resolve(runDir)))
