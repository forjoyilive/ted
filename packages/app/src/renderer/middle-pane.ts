import type { ChangesSource, Task, TaskCommit, TaskFileRef } from '@ted/protocol'
import type { ChangedFile } from './changes.ts'
import type { ShownApp } from './components/AppsSection.tsx'
import type { LineFocus } from './components/DiffViews.tsx'

export type ChangesView = (
  | { kind: 'diff'; file: ChangedFile; focus?: LineFocus }
  | { kind: 'all' }
) & { source?: ChangesSource }

export type ShownFile = TaskFileRef & { line?: number }

export interface MiddlePaneState {
  file?: { taskId: string; file: ShownFile } | undefined
  commit?: { taskId: string; commit: TaskCommit } | undefined
  run?: { taskId: string; runId: string | undefined } | undefined
  changes?: { taskId: string; view: ChangesView } | undefined
  app?: { taskId: string; app: ShownApp } | undefined
  brief?: string | undefined
  shell?: { taskId: string; repo: string } | undefined
}

export type MiddlePaneAction =
  | { kind: 'file'; file: ShownFile | undefined }
  | { kind: 'commit'; commit: TaskCommit | undefined }
  | { kind: 'run'; runId: string | undefined }
  | { kind: 'changes'; view: ChangesView | undefined }
  | { kind: 'app'; app: ShownApp | undefined }
  | { kind: 'brief'; open: boolean }
  | { kind: 'shell'; repo: string | undefined }
  | { kind: 'answered' }

export function middlePaneStep(
  state: MiddlePaneState,
  taskId: string,
  action: MiddlePaneAction,
): MiddlePaneState {
  const { run, changes, app, brief, shell, file, commit } = state
  switch (action.kind) {
    case 'file':
      if (action.file === undefined) return { run, changes, app, brief, shell, commit }
      return { run, changes, app, brief, shell, file: { taskId, file: action.file } }
    case 'commit':
      if (action.commit === undefined) return { run, changes, app, brief, shell, file }
      return { run, changes, app, brief, shell, commit: { taskId, commit: action.commit } }
    case 'run':
      return { run: { taskId, runId: action.runId } }
    case 'changes':
      if (action.view === undefined) return { run, app, brief, shell, file, commit }
      return { run, shell, changes: { taskId, view: action.view } }
    case 'app':
      if (action.app === undefined) return { run, changes, brief, shell, file, commit }
      return { run, app: { taskId, app: action.app } }
    case 'brief':
      if (!action.open) return { run, changes, app, shell, file, commit }
      return { run, brief: taskId }
    case 'shell':
      if (action.repo === undefined) return { run, changes, app, brief, file, commit }
      return { run, shell: { taskId, repo: action.repo } }
    case 'answered':
      return { shell }
  }
}

export interface MiddlePane {
  file: ShownFile | undefined
  commit: TaskCommit | undefined
  run: string | undefined
  changes: ChangesView | undefined
  app: ShownApp | undefined
  brief: boolean
  shell: string | undefined
  all: boolean
  covered: boolean
}

export function middlePane(
  state: MiddlePaneState,
  task: Pick<Task, 'id' | 'tabs' | 'repos'> & Partial<Pick<Task, 'runs' | 'leadRunId'>>,
  changesLoaded: boolean,
): MiddlePane {
  const shownRun = state.run?.taskId === task.id ? state.run.runId : undefined
  const run =
    task.tabs.some((t) => t.runId === shownRun) ||
    task.runs?.some((run) => run.id === shownRun) ||
    (shownRun !== undefined && shownRun === task.leadRunId)
      ? shownRun
      : undefined
  const changes = state.changes?.taskId === task.id ? state.changes.view : undefined
  const app = state.app?.taskId === task.id ? state.app.app : undefined
  const brief = state.brief === task.id
  const shellRepo = state.shell?.taskId === task.id ? state.shell.repo : undefined
  const live = (repo: string) => task.repos.some((r) => !r.removed && r.name === repo)
  const shell = shellRepo !== undefined && live(shellRepo) ? shellRepo : undefined
  const requestedFile = state.file?.taskId === task.id ? state.file.file : undefined
  const file = requestedFile && live(requestedFile.repo) ? requestedFile : undefined
  const requestedCommit = state.commit?.taskId === task.id ? state.commit.commit : undefined
  const commit =
    file === undefined && requestedCommit && live(requestedCommit.repo)
      ? requestedCommit
      : undefined
  const over = file !== undefined || commit !== undefined
  const all =
    !over && changes?.kind === 'all' && (changesLoaded || changes.source === 'pull-request')
  return {
    run,
    changes: over ? undefined : changes,
    app,
    brief: !over && brief,
    shell,
    all,
    file,
    commit,
    covered: over || all || changes?.kind === 'diff' || brief,
  }
}
