export type FactoryView = 'board' | 'list' | 'plans' | 'automations' | 'settings'

export type Screen =
  | { kind: 'inbox' }
  | { kind: 'all-tasks' }
  | { kind: 'factory'; factoryId: string; view: FactoryView }
  | { kind: 'settings' }
  | { kind: 'search' }
  | { kind: 'add-factory' }

export interface Navigation {
  screen: Screen
  taskId?: string
  lastFactoryId?: string
  lastViews: Readonly<Record<string, FactoryView>>
}

export type NavigationAction =
  | { type: 'open'; screen: Screen }
  | { type: 'open-factory'; factoryId: string }
  | { type: 'open-task'; taskId: string; factoryId?: string }
  | { type: 'close-task' }

export const initialNavigation: Navigation = { screen: { kind: 'inbox' }, lastViews: {} }

export function navigate(state: Navigation, action: NavigationAction): Navigation {
  switch (action.type) {
    case 'open': {
      const { taskId: _, ...rest } = state
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
    case 'open-task':
      return {
        ...state,
        taskId: action.taskId,
        ...(action.factoryId !== undefined && { lastFactoryId: action.factoryId }),
      }
    case 'close-task': {
      const { taskId: _, ...rest } = state
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
