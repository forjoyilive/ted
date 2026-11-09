import type { Task } from '@ted/protocol'
import type { ChangedFile } from './changes.ts'
import type { ShownApp } from './components/AppsSection.tsx'
import type { LineFocus } from './components/DiffViews.tsx'

export type ChangesView = { kind: 'diff'; file: ChangedFile; focus?: LineFocus } | { kind: 'all' }

export interface MiddlePaneState {
  run?: { taskId: string; runId: string | undefined } | undefined
  changes?: { taskId: string; view: ChangesView } | undefined
  app?: { taskId: string; app: ShownApp } | undefined
  brief?: string | undefined
  shell?: { taskId: string; repo: string } | undefined
}

export type MiddlePaneAction =
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
  const { run, changes, app, brief, shell } = state
  switch (action.kind) {
    case 'run':
      return { run: { taskId, runId: action.runId } }
    case 'changes':
      if (action.view === undefined) return { run, app, brief, shell }
      return { run, shell, changes: { taskId, view: action.view } }
    case 'app':
      if (action.app === undefined) return { run, changes, brief, shell }
      return { run, app: { taskId, app: action.app } }
    case 'brief':
      if (!action.open) return { run, changes, app, shell }
      return { run, brief: taskId }
    case 'shell':
      if (action.repo === undefined) return { run, changes, app, brief }
      return { run, shell: { taskId, repo: action.repo } }
    case 'answered':
      return { shell }
  }
}

export interface MiddlePane {
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
  task: Pick<Task, 'id' | 'tabs' | 'repos'>,
  changesLoaded: boolean,
): MiddlePane {
  const shownRun = state.run?.taskId === task.id ? state.run.runId : undefined
  const run = task.tabs.some((t) => t.runId === shownRun) ? shownRun : undefined
  const changes = state.changes?.taskId === task.id ? state.changes.view : undefined
  const app = state.app?.taskId === task.id ? state.app.app : undefined
  const brief = state.brief === task.id
  const shellRepo = state.shell?.taskId === task.id ? state.shell.repo : undefined
  const shell =
    shellRepo !== undefined && task.repos.some((r) => !r.removed && r.name === shellRepo)
      ? shellRepo
      : undefined
  const all = changes?.kind === 'all' && changesLoaded
  return {
    run,
    changes,
    app,
    brief,
    shell,
    all,
    covered: all || changes?.kind === 'diff' || brief,
  }
}
