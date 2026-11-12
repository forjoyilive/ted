import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

function plainFolder(folder: string): void {
  try {
    mkdirSync(folder, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  if (!lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink()) {
    throw new Error('Codex storage must be a plain folder')
  }
}

function plainFile(file: string): boolean {
  try {
    return lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return false
  }
}

export function codexHome(home: string): string {
  const folder = path.resolve(home, 'codex')
  plainFolder(folder)
  return folder
}

function sessionFile(home: string, id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid Codex session ID')
  return path.join(home, 'ted-sessions', id)
}

export function isolatedCodexSession(home: string, id: string, runDir: string): boolean {
  plainFolder(path.join(home, 'ted-sessions'))
  const marker = path.join(runDir, 'codex-home')
  return (
    (plainFile(marker) && readFileSync(marker, 'utf8') === 'isolated\n') ||
    plainFile(sessionFile(home, id))
  )
}

export function rememberCodexSession(home: string, id: string): void {
  plainFolder(home)
  plainFolder(path.join(home, 'ted-sessions'))
  const file = sessionFile(home, id)
  try {
    writeFileSync(file, '', { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !plainFile(file)) throw error
  }
}
