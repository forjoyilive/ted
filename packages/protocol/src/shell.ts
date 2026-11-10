export interface ShellSize {
  cols: number
  rows: number
}

export const shellSizeLimits = { min: 2, max: 1000 } as const

export interface TaskShell {
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
