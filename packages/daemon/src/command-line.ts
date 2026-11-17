import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { edition as builtEdition, type CommandLineStatus, type Edition } from '@ted/protocol'
import { readLoginShellPath } from './cli-env.ts'
import { RequestError } from './errors.ts'
import { exists } from './files.ts'
import { nodeEntry, shellScript } from './node-entry.ts'

export interface CommandLineOptions {
  platform?: NodeJS.Platform
  edition?: Edition
  appRoot?: string
  cliPath?: string
  env?: NodeJS.ProcessEnv
  homeDir?: string
  systemBinDir?: string
  loginPath?: () => Promise<string | undefined>
  runAsAdmin?: (source: string, target: string) => Promise<'done' | 'cancelled'>
}

export interface CommandLine {
  status(): Promise<CommandLineStatus>
  install(): Promise<CommandLineStatus>
  refresh(): Promise<void>
}

type Layout =
  | { kind: 'unavailable' }
  | { kind: 'package' }
  | { kind: 'symlink'; source: string; target: string }
  | { kind: 'appimage'; appImage: string; target: string }

const scriptMarker = 'TED_COMMAND_SCRIPT'
const addToPathLine = 'export PATH="$HOME/.local/bin:$PATH"'

export function createCommandLine(options: CommandLineOptions = {}): CommandLine {
  const platform = options.platform ?? process.platform
  const appRoot = options.appRoot ?? fileURLToPath(new URL('../../..', import.meta.url))
  const cliPath =
    options.cliPath ?? fileURLToPath(new URL('../../cli/src/main.ts', import.meta.url))
  const env = options.env ?? process.env
  const homeDir = options.homeDir ?? homedir()
  const systemBinDir = options.systemBinDir ?? '/usr/local/bin'
  const loginPath = options.loginPath ?? (() => readLoginShellPath())
  const runAsAdmin = options.runAsAdmin ?? linkAsAdmin
  const edition = options.edition ?? builtEdition

  async function layout(): Promise<Layout> {
    if (edition !== 'release') return { kind: 'unavailable' }
    const resources = path.dirname(appRoot)
    const source = path.join(resources, 'bin', 'ted')
    if (path.basename(appRoot) !== 'app' || !(await exists(source))) return { kind: 'unavailable' }
    if (platform === 'darwin') {
      return { kind: 'symlink', source, target: path.join(systemBinDir, 'ted') }
    }
    if (platform !== 'linux') return { kind: 'unavailable' }
    const packageType = await readFile(path.join(resources, 'package-type'), 'utf8').catch(() => '')
    if (['deb', 'rpm'].includes(packageType.trim())) return { kind: 'package' }
    if (env.APPIMAGE) {
      return {
        kind: 'appimage',
        appImage: env.APPIMAGE,
        target: path.join(homeDir, '.local', 'bin', 'ted'),
      }
    }
    return { kind: 'unavailable' }
  }

  async function statusOf(place: Layout): Promise<CommandLineStatus> {
    if (place.kind === 'unavailable' || place.kind === 'package') return { state: place.kind }
    const { target } = place
    const found = await lstat(target).catch(() => undefined)
    if (!found) return { state: 'not-installed', path: target }
    if (place.kind === 'symlink') {
      if (!found.isSymbolicLink()) return { state: 'taken', path: target }
      const resolved = await realpath(target).catch(() => undefined)
      if (resolved === undefined) return { state: 'not-installed', path: target }
      if (resolved === (await realpath(place.source))) return { state: 'installed', path: target }
      return isTedCommand(resolved)
        ? { state: 'not-installed', path: target }
        : { state: 'taken', path: target }
    }
    if (!(await isOurScript(target))) return { state: 'taken', path: target }
    const dir = path.dirname(target)
    const onPath = (await loginPath())?.split(path.delimiter).includes(dir) ?? false
    return {
      state: 'installed',
      path: target,
      ...(!onPath && { addToPath: addToPathLine }),
    }
  }

  async function writeScript(appImage: string, target: string): Promise<void> {
    await mkdir(path.dirname(target), { recursive: true })
    const script = shellScript(nodeEntry(cliPath, [], env), {
      [scriptMarker]: 'appimage',
      TED_APP_EXECUTABLE: appImage,
      ELECTRON_RUN_AS_NODE: '1',
    })
    const tmp = `${target}.${process.pid}.tmp`
    await writeFile(tmp, script, { mode: 0o755 })
    await rename(tmp, target)
  }

  return {
    async status() {
      return statusOf(await layout())
    },
    async install() {
      const place = await layout()
      const before = await statusOf(place)
      if (before.state === 'unavailable') {
        throw new RequestError(409, 'Only an installed copy of Ted can install the ted command.')
      }
      if (before.state === 'package') {
        throw new RequestError(409, 'Your package already installed the ted command.')
      }
      if (before.state === 'taken') {
        throw new RequestError(409, `Another program is already at ${before.path}.`)
      }
      if (place.kind === 'appimage') {
        await writeScript(place.appImage, place.target)
      } else if (place.kind === 'symlink') {
        const writable = await access(path.dirname(place.target), constants.W_OK).then(
          () => true,
          () => false,
        )
        if (writable) {
          await rm(place.target, { force: true })
          await symlink(place.source, place.target)
        } else if ((await runAsAdmin(place.source, place.target)) === 'cancelled') {
          return statusOf(place)
        }
      }
      return statusOf(place)
    },
    async refresh() {
      const place = await layout()
      if (place.kind !== 'appimage' || !(await isOurScript(place.target))) return
      await writeScript(place.appImage, place.target)
    },
  }
}

function isTedCommand(resolved: string): boolean {
  return resolved.endsWith(path.join('.app', 'Contents', 'Resources', 'bin', 'ted'))
}

async function isOurScript(file: string): Promise<boolean> {
  const text = await readFile(file, 'utf8').catch(() => '')
  return text.startsWith('#!/bin/sh\n') && text.includes(`\nexport ${scriptMarker}=`)
}

function linkAsAdmin(source: string, target: string): Promise<'done' | 'cancelled'> {
  const script = [
    'on run argv',
    'do shell script "mkdir -p " & quoted form of item 2 of argv & " && ln -sfn " & quoted form of item 1 of argv & " " & quoted form of item 3 of argv with prompt "Ted needs your password to install the ted command in " & item 2 of argv & "." with administrator privileges',
    'end run',
  ]
  const args = [...script.flatMap((line) => ['-e', line]), source, path.dirname(target), target]
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', args, (error, _stdout, stderr) => {
      if (!error) return resolve('done')
      if (String(stderr).includes('(-128)')) return resolve('cancelled')
      reject(new Error(`Ted couldn’t install the ted command: ${String(stderr).trim()}`))
    })
  })
}
