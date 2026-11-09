export const settingsSectionIds = [
  'general',
  'notifications',
  'agents',
  'limits',
  'integrations',
  'library',
  'storage',
  'developer',
] as const

export type SettingsSectionId = (typeof settingsSectionIds)[number]

export type FactoryView = 'board' | 'list' | 'plans' | 'automations' | 'settings'

export type Screen =
  | { kind: 'inbox'; factoryId?: string; answered?: boolean }
  | { kind: 'all-tasks' }
  | { kind: 'factory'; factoryId: string; view: FactoryView }
  | { kind: 'search' }

export interface Navigation {
  screen: Screen
  taskId?: string
  requestId?: string
  lastFactoryId?: string
  lastViews: Readonly<Record<string, FactoryView>>
  settings?: { section: SettingsSectionId }
  lastSettingsSection: SettingsSectionId
}

export type NavigationAction =
  | { type: 'open'; screen: Screen }
  | { type: 'open-factory'; factoryId: string }
  | { type: 'open-task'; taskId: string; factoryId?: string; requestId?: string }
  | { type: 'close-task' }
  | { type: 'open-settings'; section?: SettingsSectionId }
  | { type: 'close-settings' }

export const initialNavigation: Navigation = {
  screen: { kind: 'inbox' },
  lastViews: {},
  lastSettingsSection: 'general',
}

export function navigate(state: Navigation, action: NavigationAction): Navigation {
  switch (action.type) {
    case 'open': {
      const { taskId: _, requestId: ___, settings: __, ...rest } = state
      if (action.screen.kind !== 'factory') return { ...rest, screen: action.screen }
      const { factoryId, view } = action.screen
      return {
        ...rest,
        screen: action.screen,
        lastFactoryId: factoryId,
        lastViews: { ...state.lastViews, [factoryId]: view },
      }
    }
    case 'open-factory': {
      const view = state.lastViews[action.factoryId] ?? 'board'
      return navigate(state, {
        type: 'open',
        screen: { kind: 'factory', factoryId: action.factoryId, view },
      })
    }
    case 'open-task': {
      const { requestId: _, ...rest } = state
      return {
        ...rest,
        taskId: action.taskId,
        ...(action.requestId !== undefined && { requestId: action.requestId }),
        ...(action.factoryId !== undefined && { lastFactoryId: action.factoryId }),
      }
    }
    case 'close-task': {
      const { taskId: _, requestId: __, ...rest } = state
      return rest
    }
    case 'open-settings': {
      const section = action.section ?? state.settings?.section ?? state.lastSettingsSection
      return { ...state, settings: { section }, lastSettingsSection: section }
    }
    case 'close-settings': {
      const { settings: _, ...rest } = state
      return rest
    }
  }
}

export function currentFactoryId(
  state: Navigation,
  tasks: readonly { id: string; factoryId: string }[],
): string | undefined {
  const task = state.taskId === undefined ? undefined : tasks.find((t) => t.id === state.taskId)
  if (task) return task.factoryId
  if (state.screen.kind === 'factory') return state.screen.factoryId
  return state.lastFactoryId
}

export function backLink(state: Navigation): string | undefined {
  if (state.taskId === undefined) return undefined
  const { screen } = state
  if (screen.kind === 'all-tasks') return '← All Tasks'
  if (screen.kind === 'factory' && screen.view === 'board') return '← Board'
  if (screen.kind === 'factory' && screen.view === 'list') return '← List'
  return undefined
}
