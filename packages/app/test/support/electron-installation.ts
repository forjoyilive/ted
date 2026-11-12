import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { acquireSuiteLock } from '../../../daemon/test/support/suite-lock.ts'

const require = createRequire(import.meta.url)
const execute = promisify(execFile)
const preparing = new Map<string, Promise<string>>()

function packageFolder(): string {
  return path.dirname(require.resolve('electron/package.json'))
}

export function resolveElectron(folder = packageFolder()): string {
  try {
    const relative = readFileSync(path.join(folder, 'path.txt'), 'utf8').trim()
    if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..'))
      throw new Error('invalid executable path in path.txt')
    const version = JSON.parse(readFileSync(path.join(folder, 'package.json'), 'utf8')).version
    if (
      readFileSync(path.join(folder, 'dist/version'), 'utf8').trim().replace(/^v/, '') !== version
    )
      throw new Error('installed version does not match the package')
    const executable = path.join(
      process.env.ELECTRON_OVERRIDE_DIST_PATH || path.join(folder, 'dist'),
      relative,
    )
    accessSync(executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return executable
  } catch (cause) {
    throw new Error(
      `Electron is not ready for native tests (${folder}). Run the Electron test preflight before collection.`,
      { cause },
    )
  }
}

export async function prepareElectron(folder = packageFolder()): Promise<string> {
  const real = realpathSync(folder)
  const current = preparing.get(real)
  if (current) return current
  const pending = prepare(real)
  preparing.set(real, pending)
  try {
    return await pending
  } finally {
    preparing.delete(real)
  }
}

async function prepare(folder: string): Promise<string> {
  const hash = createHash('sha256').update(folder).digest('hex')
  const unlock = await acquireSuiteLock({
    file: path.join(tmpdir(), 'ted-electron-install', `${hash}.lock`),
  })
  try {
    try {
      return resolveElectron(folder)
    } catch {
      console.log('Preparing Electron before native test collection…')
    }
    try {
      await execute(process.execPath, [path.join(folder, 'install.js')], { timeout: 180_000 })
      return resolveElectron(folder)
    } catch (cause) {
      throw new Error(
        `Electron preflight failed (${folder}); native tests were not collected. Check the installation error before retrying.`,
        { cause },
      )
    }
  } finally {
    await unlock()
  }
}
