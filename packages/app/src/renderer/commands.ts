import type { Factory, Task } from '@ted/protocol'
import { clarifyDepths, clarifyIsOver, priorities } from '@ted/protocol/task'
import {
  archiveTaskEvent,
  deleteTaskEvent,
  followUpTaskEvent,
} from './components/ArchiveDialogs.tsx'
import { pickBlockerEvent } from './components/TaskActions.tsx'
import { openInEditor } from './editor.ts'
import type { NavigationAction } from './navigation.ts'
import { hasWorktree, openTaskShell } from './shell.ts'
import { runStatusAction, statusAction } from './task-actions.ts'
import { clarifyDepthLabels, priorityLabels } from './task-fields.ts'
import { ted } from './ted.ts'
import { editTaskEvent } from './views/EditTaskDialog.tsx'

export interface CommandContext {
  task: Task | undefined
  factories: readonly Factory[]
  dispatch: (action: NavigationAction) => void
  newTask: (description?: string) => void
  addFactory: () => void
}

export interface CommandChoice {
  id: string
  label: string
  checked?: boolean
  shortcut?: string
  run: () => unknown
}

export interface Command {
  id: string
  label: string
  scope: 'global' | 'task'
  shortcuts?: readonly string[]
  keywords?: string
  run?: (context: CommandContext) => unknown
  choices?: (context: CommandContext) => CommandChoice[]
}

export const shellShortcuts: readonly string[] = ['⌃`']

const taskEvent = (name: string, task: Task | undefined) => {
  if (task) window.dispatchEvent(new CustomEvent(name, { detail: task.id }))
}

export const globalCommands: readonly Command[] = [
  {
    id: 'new-task',
    label: 'New Task',
    scope: 'global',
    shortcuts: ['⌘N', 'C'],
    run: ({ newTask }) => newTask(),
  },
  {
    id: 'go-to-inbox',
    label: 'Go to Inbox',
    scope: 'global',
    shortcuts: ['G I'],
    run: ({ dispatch }) => dispatch({ type: 'open', screen: { kind: 'inbox' } }),
  },
  {
    id: 'go-to-all-tasks',
    label: 'Go to All Tasks',
    scope: 'global',
    shortcuts: ['G A'],
    run: ({ dispatch }) => dispatch({ type: 'open', screen: { kind: 'all-tasks' } }),
  },
  {
    id: 'go-to-automations',
    label: 'Go to Automations…',
    scope: 'global',
    keywords: 'new automation schedule',
    choices: ({ factories, dispatch }) =>
      factories.map((factory) => ({
        id: factory.id,
        label: factory.name,
        run: () =>
          dispatch({
            type: 'open',
            screen: { kind: 'factory', factoryId: factory.id, view: 'automations' },
          }),
      })),
  },
  {
    id: 'open-factory',
    label: 'Open a Factory…',
    scope: 'global',
    shortcuts: ['⌘1–⌘9'],
    keywords: 'switch',
    choices: ({ factories, dispatch }) =>
      factories.map((factory, index) => ({
        id: factory.id,
        label: factory.name,
        ...(index < 9 && { shortcut: factoryShortcut(index) }),
        run: () => dispatch({ type: 'open-factory', factoryId: factory.id }),
      })),
  },
  {
    id: 'settings',
    label: 'Settings',
    scope: 'global',
    shortcuts: ['⌘,'],
    keywords: 'preferences',
    run: ({ dispatch }) => dispatch({ type: 'open-settings' }),
  },
  {
    id: 'add-factory',
    label: 'Add Factory',
    scope: 'global',
    run: ({ addFactory }) => addFactory(),
  },
]

export function taskCommands(task: Task): Command[] {
  if (task.archived) {
    return [
      {
        id: 'unarchive',
        label: 'Unarchive',
        scope: 'task',
        run: () => ted.unarchiveTask(task.id),
      },
      {
        id: 'delete',
        label: 'Delete…',
        scope: 'task',
        run: () => taskEvent(deleteTaskEvent, task),
      },
    ]
  }
  const action = statusAction(task)
  const list: Command[] = []
  if (action) {
    list.push({
      id: action.kind,
      label: action.label,
      scope: 'task',
      ...(['start', 'resume', 'retry'].includes(action.kind) && { shortcuts: ['S'] }),
      run: () =>
        action.kind === 'follow-up'
          ? taskEvent(followUpTaskEvent, task)
          : runStatusAction(action.kind, task),
    })
  }
  list.push({
    id: 'set-priority',
    label: 'Set Priority…',
    scope: 'task',
    shortcuts: ['P'],
    choices: () =>
      priorities.map((priority) => ({
        id: priority,
        label: priority === 'none' ? 'No priority' : priorityLabels[priority],
        checked: task.priority === priority,
        run: () => ted.setPriority(task.id, priority),
      })),
  })
  if (task.stage !== 'done' && !clarifyIsOver(task.stage)) {
    list.push({
      id: 'set-clarify-depth',
      label: 'Set Clarify depth…',
      scope: 'task',
      choices: () =>
        clarifyDepths.map((depth) => ({
          id: depth,
          label: clarifyDepthLabels[depth],
          checked: task.clarifyDepth === depth,
          run: () => ted.setClarifyDepth(task.id, depth),
        })),
    })
  }
  if (task.stage !== 'done') {
    list.push({
      id: 'blocked-by',
      label: 'Blocked by…',
      scope: 'task',
      shortcuts: ['B'],
      run: () => taskEvent(pickBlockerEvent, task),
    })
  }
  if (hasWorktree(task)) {
    list.push({
      id: 'shell',
      label: 'Open shell',
      scope: 'task',
      shortcuts: shellShortcuts,
      keywords: 'terminal worktree',
      run: () => openTaskShell(task),
    })
    const repo = task.repos.find((r) => !r.removed)
    if (repo) {
      list.push({
        id: 'open-in-editor',
        label: 'Open in editor',
        scope: 'task',
        keywords: 'vs code cursor zed worktree',
        run: () => openInEditor({ taskId: task.id, repo: repo.name }),
      })
    }
  }
  list.push(
    {
      id: 'edit',
      label: 'Edit title and description…',
      scope: 'task',
      shortcuts: ['E'],
      run: () => taskEvent(editTaskEvent, task),
    },
    {
      id: 'archive',
      label: 'Archive…',
      scope: 'task',
      shortcuts: ['⌘⌫'],
      run: () => taskEvent(archiveTaskEvent, task),
    },
    {
      id: 'delete',
      label: 'Delete…',
      scope: 'task',
      run: () => taskEvent(deleteTaskEvent, task),
    },
  )
  return list
}

export function factoryShortcut(index: number): string {
  return `⌘${index + 1}`
}

export function factoryCommands(factories: readonly Factory[]): Command[] {
  return factories.map((factory, index) => ({
    id: `open-factory:${factory.id}`,
    label: `Open ${factory.name}`,
    scope: 'global',
    keywords: 'factory',
    ...(index < 9 && { shortcuts: [factoryShortcut(index)] }),
    run: ({ dispatch }) => dispatch({ type: 'open-factory', factoryId: factory.id }),
  }))
}

export function availableCommands(context: CommandContext): Command[] {
  return [
    ...(context.task ? taskCommands(context.task) : []),
    ...globalCommands,
    ...factoryCommands(context.factories),
  ]
}
