import type { Factory, Task } from '@ted/protocol'
import { clarifyDepths, clarifyIsOver, priorities } from '@ted/protocol/task'
import type { ArmAction } from './armed.ts'
import {
  archiveTaskEvent,
  deleteTaskEvent,
  followUpTaskEvent,
} from './components/ArchiveDialogs.tsx'
import { snoozeTaskEvent } from './components/SnoozeTaskDialog.tsx'
import { pickBlockerEvent } from './components/TaskActions.tsx'
import { detailsTabNames, detailsTabs, showDetailsTab } from './details.ts'
import { openInEditor } from './editor.ts'
import { openTaskFiles } from './files.ts'
import type { Direction } from './key-targets.ts'
import { keysFor } from './keymap.ts'
import type { FactoryView, NavigationAction } from './navigation.ts'
import { hasWorktree, openTaskShell } from './shell.ts'
import { runStatusAction, shortcutAction, statusAction } from './task-actions.ts'
import { clarifyDepthLabels, priorityLabels } from './task-fields.ts'
import { ted } from './ted.ts'
import { editTaskEvent } from './views/EditTaskDialog.tsx'

export interface KeyActions {
  togglePalette: () => boolean
  openSheet: () => void
  back: () => void
  forward: () => void
  close: () => boolean
  move: (direction: Direction) => boolean
  snoozeRequest: () => boolean
  arm: (action: ArmAction) => boolean
  reply: () => boolean
  requestChanges: () => boolean
  pressDialogPrimary: () => boolean
  focusFilter: () => boolean
  moveInRank: (direction: 'up' | 'down') => boolean
  select: () => boolean
}

export interface CommandContext {
  task: Task | undefined
  factories: readonly Factory[]
  factoryId?: string | undefined
  dispatch: (action: NavigationAction) => void
  newTask: (description?: string) => void
  newAutomation: () => void
  addFactory: () => void
  keys?: KeyActions
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
  palette?: false
  inDialogs?: true
  run?: (context: CommandContext) => unknown
  choices?: (context: CommandContext) => CommandChoice[]
}

const taskEvent = (name: string, task: Task | undefined) => {
  if (task) window.dispatchEvent(new CustomEvent(name, { detail: task.id }))
}

const goToView = (view: FactoryView) => (context: CommandContext) => {
  const factoryId = context.factoryId ?? context.factories[0]?.id
  if (factoryId === undefined) return false
  context.dispatch({ type: 'open', screen: { kind: 'factory', factoryId, view } })
  return true
}

export const globalCommands: readonly Command[] = [
  {
    id: 'new-task',
    label: 'New Task',
    scope: 'global',
    shortcuts: keysFor('new-task'),
    run: ({ newTask }) => newTask(),
  },
  {
    id: 'go-to-inbox',
    label: 'Go to Inbox',
    scope: 'global',
    shortcuts: keysFor('go-to-inbox'),
    run: ({ dispatch }) => dispatch({ type: 'open', screen: { kind: 'inbox' } }),
  },
  {
    id: 'go-to-all-tasks',
    label: 'Go to All Tasks',
    scope: 'global',
    shortcuts: keysFor('go-to-all-tasks'),
    run: ({ dispatch }) => dispatch({ type: 'open', screen: { kind: 'all-tasks' } }),
  },
  {
    id: 'go-to-dashboard',
    label: 'Go to Dashboard',
    scope: 'global',
    shortcuts: keysFor('go-to-dashboard'),
    run: goToView('dashboard'),
  },
  {
    id: 'go-to-board',
    label: 'Go to Board',
    scope: 'global',
    shortcuts: keysFor('go-to-board'),
    run: goToView('board'),
  },
  {
    id: 'go-to-list',
    label: 'Go to List',
    scope: 'global',
    shortcuts: keysFor('go-to-list'),
    run: goToView('list'),
  },
  {
    id: 'go-to-map',
    label: 'Go to Map',
    scope: 'global',
    keywords: 'blockers blocked by dependencies',
    shortcuts: keysFor('go-to-map'),
    run: goToView('map'),
  },
  {
    id: 'go-to-plans',
    label: 'Go to Plans',
    scope: 'global',
    shortcuts: keysFor('go-to-plans'),
    run: goToView('plans'),
  },
  {
    id: 'plan',
    label: 'Plan…',
    scope: 'global',
    keywords: 'planning chat new plan',
    choices: ({ factories, dispatch }) =>
      factories
        .filter((factory) => factory.cloned)
        .map((factory) => ({
          id: factory.id,
          label: factory.name,
          run: () => dispatch({ type: 'open-plan', factoryId: factory.id }),
        })),
  },
  {
    id: 'go-to-automations',
    label: 'Go to Automations…',
    scope: 'global',
    keywords: 'automations schedule',
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
    shortcuts: keysFor('open-factory'),
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
    id: 'new-automation',
    label: 'New Automation',
    scope: 'global',
    keywords: 'schedule automation',
    run: ({ newAutomation }) => newAutomation(),
  },
  {
    id: 'settings',
    label: 'Settings',
    scope: 'global',
    shortcuts: keysFor('settings'),
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
  if (task.stage === 'backlog' && !task.setup) {
    list.push({
      id: 'snooze',
      label: task.snoozedUntil ? 'Change snooze…' : 'Snooze…',
      scope: 'task',
      run: () => taskEvent(snoozeTaskEvent, task),
    })
    if (task.snoozedUntil)
      list.push({
        id: 'cancel-snooze',
        label: 'Cancel snooze',
        scope: 'task',
        run: () => ted.setTaskSnooze(task.id, null),
      })
  }
  if (action) {
    list.push({
      id: action.kind,
      label: action.label,
      scope: 'task',
      ...(shortcutAction(task) && { shortcuts: keysFor('status') }),
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
    shortcuts: keysFor('set-priority'),
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
          run: () => ted.setClarifyDepth(task.id, { depth: depth }),
        })),
    })
  }
  if (task.stage !== 'done') {
    list.push({
      id: 'blocked-by',
      label: 'Blocked by…',
      scope: 'task',
      shortcuts: keysFor('blocked-by'),
      run: () => taskEvent(pickBlockerEvent, task),
    })
  }
  for (const tab of detailsTabs) {
    list.push({
      id: `details-tab-${tab}`,
      label: `Show the ${detailsTabNames[tab]} tab`,
      scope: 'task',
      shortcuts: keysFor(`details-tab-${tab}`),
      keywords: 'task details sidebar tab',
      run: ({ task: open, dispatch }) => {
        if (open?.id !== task.id) {
          dispatch({ type: 'open-task', taskId: task.id, factoryId: task.factoryId })
        }
        showDetailsTab(tab)
      },
    })
  }
  if (hasWorktree(task)) {
    list.push({
      id: 'quick-open',
      label: 'Open a file…',
      scope: 'task',
      shortcuts: keysFor('quick-open'),
      keywords: 'files quick open worktree',
      run: ({ task: open, dispatch }) => {
        if (open?.id !== task.id)
          dispatch({ type: 'open-task', taskId: task.id, factoryId: task.factoryId })
        openTaskFiles(task.id)
      },
    })
    list.push({
      id: 'shell',
      label: 'Open shell',
      scope: 'task',
      shortcuts: keysFor('shell'),
      keywords: 'terminal worktree',
      run: ({ task: open, dispatch }) => {
        if (open?.id !== task.id) {
          dispatch({ type: 'open-task', taskId: task.id, factoryId: task.factoryId })
        }
        openTaskShell(task)
      },
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
      shortcuts: keysFor('edit'),
      run: () => taskEvent(editTaskEvent, task),
    },
    {
      id: 'archive',
      label: 'Archive…',
      scope: 'task',
      shortcuts: keysFor('archive'),
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

function keyCommand(
  id: string,
  label: string,
  run: (keys: KeyActions) => unknown,
  options: { inDialogs?: true; inPalette?: true; keywords?: string } = {},
): Command {
  return {
    id,
    label,
    scope: 'global',
    shortcuts: keysFor(id),
    ...(!options.inPalette && { palette: false as const }),
    ...(options.inDialogs && { inDialogs: true as const }),
    ...(options.keywords !== undefined && { keywords: options.keywords }),
    run: ({ keys }) => (keys ? run(keys) : false),
  }
}

export const keyCommands: readonly Command[] = [
  keyCommand('search', 'Search and commands', (k) => k.togglePalette(), { inDialogs: true }),
  keyCommand('shortcuts', 'Keyboard shortcuts', (k) => k.openSheet(), {
    inPalette: true,
    keywords: 'keys help',
  }),
  keyCommand('back', 'Back', (k) => k.back()),
  keyCommand('forward', 'Forward', (k) => k.forward()),
  keyCommand('close', 'Close', (k) => k.close()),
  keyCommand('next', 'Next', (k) => k.move('next')),
  keyCommand('previous', 'Previous', (k) => k.move('previous')),
  keyCommand('column-left', 'Column to the left', (k) => k.move('left')),
  keyCommand('column-right', 'Column to the right', (k) => k.move('right')),
  keyCommand('snooze-request', 'Snooze the selected request', (k) =>
    k.snoozeRequest() ? true : k.move('left'),
  ),
  keyCommand('reply', 'Reply', (k) => k.reply()),
  keyCommand('approve', 'Approve', (k) => k.arm('approve')),
  keyCommand('request-changes', 'Request changes', (k) => k.requestChanges()),
  keyCommand('send', 'Send', (k) => k.pressDialogPrimary(), { inDialogs: true }),
  keyCommand('move-up', 'Move up in rank', (k) => k.moveInRank('up')),
  keyCommand('move-down', 'Move down in rank', (k) => k.moveInRank('down')),
  keyCommand('filter', 'Filter', (k) => k.focusFilter()),
  keyCommand('select', 'Select or deselect', (k) => k.select()),
]

export function availableCommands(context: CommandContext): Command[] {
  return [
    ...(context.task ? taskCommands(context.task) : []),
    ...globalCommands,
    ...factoryCommands(context.factories),
    ...(context.keys ? keyCommands : []),
  ]
}

export function paletteCommands(context: CommandContext): Command[] {
  return availableCommands(context).filter((command) => command.palette !== false)
}
