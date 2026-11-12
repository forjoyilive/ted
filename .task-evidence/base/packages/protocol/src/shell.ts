export interface ShellSize {
  cols: number
  rows: number
}

export interface ShellWorkspaceRequest extends ShellSize {
  create?: boolean
}

export const shellSizeLimits = { min: 2, max: 1000 } as const

export const maxShellPanes = 8

export type ShellLayout =
  | { shellId: string }
  | {
      id: string
      direction: 'right' | 'below'
      ratio: number
      first: ShellLayout
      second: ShellLayout
    }

export interface ShellWorkspace {
  revision: number
  layout: ShellLayout | null
  shells: TaskShell[]
}

export type ShellChange =
  | {
      kind: 'split'
      revision: number
      shellId: string
      direction: 'right' | 'below'
      size: ShellSize
    }
  | { kind: 'close'; revision: number; shellId: string }
  | { kind: 'ratio'; revision: number; branchId: string; ratio: number }

export interface TaskShell {
  id: string
  taskId: string
  repo: string
  path: string
  generation: number
  running: boolean
  exitCode?: number
}

export interface ShellOutput {
  generation: number
  data: string
  next: number
  reset: boolean
  running: boolean
  exitCode?: number
}

export interface ShellOutputQuery {
  generation: number
  from: number
  waitMs?: number
}

export const maxShellInputChars = 64 * 1024

export const editorIds = [
  'code',
  'cursor',
  'zed',
  'windsurf',
  'subl',
  'idea',
  'webstorm',
  'pycharm',
  'goland',
  'phpstorm',
  'rubymine',
  'clion',
  'rider',
  'rustrover',
  'xed',
] as const

export type EditorId = (typeof editorIds)[number]

export type EditorChoice = EditorId | 'custom'

export const editorNames: Readonly<Record<EditorId, string>> = {
  code: 'VS Code',
  cursor: 'Cursor',
  zed: 'Zed',
  windsurf: 'Windsurf',
  subl: 'Sublime Text',
  idea: 'IntelliJ IDEA',
  webstorm: 'WebStorm',
  pycharm: 'PyCharm',
  goland: 'GoLand',
  phpstorm: 'PhpStorm',
  rubymine: 'RubyMine',
  clion: 'CLion',
  rider: 'Rider',
  rustrover: 'RustRover',
  xed: 'Xcode',
}

export interface FoundEditor {
  id: EditorId
  name: string
  path: string
}

export const editorPlaceholders = ['{path}', '{line}', '{column}'] as const

export interface OpenInEditorRequest {
  snapshot?: boolean
  file?: string
  line?: number
  column?: number
}

export interface ShellInputRequest {
  data: string
}
