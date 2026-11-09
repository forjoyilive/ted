import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  type EditorId,
  editorIds,
  editorNames,
  type FoundEditor,
  type MachineSettings,
  type OpenInEditorRequest,
} from '@ted/protocol'
import { worktreeCommandEnv } from './command-env.ts'
import { RequestError } from './errors.ts'

export interface EditorLaunch {
  program: string
  args: string[]
  cwd: string
}

export type LaunchEditor = (launch: EditorLaunch, env: NodeJS.ProcessEnv) => Promise<void>

export interface EditorsOptions {
  env: () => NodeJS.ProcessEnv
  settings: () => MachineSettings
  appDirs?: readonly string[]
  launch?: LaunchEditor
}

export interface EditorTarget {
  worktree: string
}

export interface Editors {
  found(): Promise<FoundEditor[]>
  open(target: EditorTarget, request: OpenInEditorRequest): Promise<void>
}

const bundled: Partial<Record<EditorId, string[]>> = {
  code: ['Visual Studio Code.app/Contents/Resources/app/bin/code'],
  cursor: ['Cursor.app/Contents/Resources/app/bin/cursor'],
  windsurf: ['Windsurf.app/Contents/Resources/app/bin/windsurf'],
  zed: ['Zed.app/Contents/MacOS/cli'],
  subl: ['Sublime Text.app/Contents/SharedSupport/bin/subl'],
}

const jetBrains: readonly EditorId[] = [
  'idea',
  'webstorm',
  'pycharm',
  'goland',
  'phpstorm',
  'rubymine',
  'clion',
  'rider',
  'rustrover',
]

export function defaultAppDirs(): string[] {
  const given = process.env.TED_EDITOR_APP_DIRS
  if (given !== undefined) return given.split(path.delimiter).filter((dir) => dir !== '')
  if (process.platform !== 'darwin') return []
  return ['/Applications', path.join(homedir(), 'Applications')]
}

export interface EditorPlace {
  file: string
  line: number
  column: number
}

export function editorArgs(id: EditorId, worktree: string, place?: EditorPlace): string[] {
  if (!place) return [worktree]
  const at = `${place.file}:${place.line}:${place.column}`
  if (id === 'code' || id === 'cursor' || id === 'windsurf') return [worktree, '--goto', at]
  if (id === 'zed' || id === 'subl') return [worktree, at]
  if (id === 'xed') return ['--line', String(place.line), place.file]
  if (jetBrains.includes(id)) {
    return ['--line', String(place.line), '--column', String(place.column), place.file]
  }
  return [place.file]
}

export function parseEditorCommand(command: string): string[] {
  if (/[\0\r\n]/.test(command)) throw new Error('The command must be one line.')
  const words: string[] = []
  let word = ''
  let started = false
  let quote: '"' | "'" | undefined
  for (let i = 0; i < command.length; i++) {
    const char = command[i] ?? ''
    if (quote) {
      if (char === quote) quote = undefined
      else if (char === '\\' && quote === '"' && i + 1 < command.length) word += command[++i]
      else word += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (char === '\\' && i + 1 < command.length) {
      word += command[++i]
      started = true
    } else if (/\s/.test(char)) {
      if (started) words.push(word)
      word = ''
      started = false
    } else {
      word += char
      started = true
    }
  }
  if (quote) throw new Error('The command has a quote that isn’t closed.')
  if (started) words.push(word)
  return words
}

export function customArgs(
  command: string,
  worktree: string,
  place?: EditorPlace,
): { program: string; args: string[] } {
  const words = parseEditorCommand(command)
  const [program, ...rest] = words
  if (program === undefined) throw new RequestError(400, 'The custom editor command is empty.')
  const target = place?.file ?? worktree
  const fill = (word: string) =>
    word
      .replaceAll('{path}', target)
      .replaceAll('{line}', String(place?.line ?? 1))
      .replaceAll('{column}', String(place?.column ?? 1))
  const args = rest.map(fill)
  if (!rest.some((word) => word.includes('{path}'))) args.push(target)
  return { program: fill(program), args }
}

async function executable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK)
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

async function onPath(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue
    const file = path.join(dir, name)
    if (await executable(file)) return file
  }
  return undefined
}

const spawnEditor: LaunchEditor = (launch, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(launch.program, launch.args, {
      cwd: launch.cwd,
      env,
      detached: true,
      stdio: 'ignore',
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })

export function createEditors(options: EditorsOptions): Editors {
  const appDirs = options.appDirs ?? defaultAppDirs()
  const launch = options.launch ?? spawnEditor

  async function find(id: EditorId): Promise<string | undefined> {
    const listed = await onPath(id, options.env())
    if (listed) return listed
    for (const dir of appDirs) {
      for (const inside of bundled[id] ?? []) {
        const file = path.join(dir, inside)
        if (await executable(file)) return file
      }
    }
    return undefined
  }

  async function place(worktree: string, request: OpenInEditorRequest) {
    if (request.file === undefined) return undefined
    const file = request.file
    if (file === '' || path.isAbsolute(file) || file.includes('\0')) {
      throw new RequestError(400, 'file must be a path inside the worktree')
    }
    const root = await realpath(worktree)
    const inside = (candidate: string) => candidate.startsWith(`${root}${path.sep}`)
    const resolved = path.resolve(root, file)
    if (!inside(resolved)) throw new RequestError(400, 'file must be a path inside the worktree')
    const real = await realpath(resolved).catch(() => undefined)
    if (real === undefined) throw new RequestError(404, `${file} isn’t in the worktree`)
    if (!inside(real)) throw new RequestError(400, 'file must be a path inside the worktree')
    return {
      file: path.join(worktree, path.relative(root, real)),
      line: request.line ?? 1,
      column: request.column ?? 1,
    }
  }

  return {
    async found() {
      const list = await Promise.all(
        editorIds.map(async (id) => {
          const file = await find(id)
          return file === undefined ? [] : [{ id, name: editorNames[id], path: file }]
        }),
      )
      return list.flat()
    },

    async open(target, request) {
      const { editor, editorCommand } = options.settings()
      if (editor === null) throw new RequestError(409, 'Choose an editor first.')
      const at = await place(target.worktree, request)
      const env = worktreeCommandEnv({}, {}, options.env())
      let program: string
      let args: string[]
      let name: string
      if (editor === 'custom') {
        try {
          ;({ program, args } = customArgs(editorCommand, target.worktree, at))
        } catch (error) {
          if (error instanceof RequestError) throw error
          throw new RequestError(400, error instanceof Error ? error.message : String(error))
        }
        name = program
      } else {
        const file = await find(editor)
        name = editorNames[editor]
        if (file === undefined) {
          throw new RequestError(404, `TED can’t find ${name}. Choose another editor in Settings.`)
        }
        program = file
        args = editorArgs(editor, target.worktree, at)
      }
      await launch({ program, args, cwd: target.worktree }, env).catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error)
        throw new RequestError(422, `Couldn’t start ${name}: ${reason}`)
      })
    },
  }
}
