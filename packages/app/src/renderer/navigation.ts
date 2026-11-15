import type { DashboardViewState } from './dashboard.ts'
import type { FactorySectionId } from './settings-search.ts'

export const settingsSectionIds = [
  'general',
  'notifications',
  'machines',
  'agents',
  'limits',
  'integrations',
  'library',
  'storage',
  'developer',
] as const

export type SettingsSectionId = (typeof settingsSectionIds)[number]

export const remoteExecution =
  typeof location !== 'undefined' &&
  new URLSearchParams(location.search).get('remoteExecution') === 'on'

export const shownSettingsSectionIds: readonly SettingsSectionId[] = settingsSectionIds.filter(
  (id) => id !== 'machines' || remoteExecution,
)

export type FactoryView =
  | 'coordinator'
  | 'board'
  | 'list'
  | 'map'
  | 'plans'
  | 'automations'
  | 'settings'

export const taskViews = ['board', 'list', 'map'] as const satisfies readonly FactoryView[]

export function isTaskView(view: FactoryView): view is (typeof taskViews)[number] {
  return (taskViews as readonly FactoryView[]).includes(view)
}

export type Screen =
  | { kind: 'inbox'; factoryId?: string; answered?: boolean }
  | { kind: 'all-tasks' }
  | { kind: 'dashboard'; dashboard?: Partial<DashboardViewState> }
  | {
      kind: 'factory'
      factoryId: string
      view: FactoryView
      section?: FactorySectionId
    }

export interface Navigation {
  screen: Screen
  taskId?: string
  requestId?: string
  automation?: { id: string; runId?: string }
  planId?: string
  planFrom?: string
  lastFactoryId?: string
  lastViews: Readonly<Record<string, FactoryView>>
  lastTaskViews: Readonly<Record<string, (typeof taskViews)[number]>>
  settings?: { section: SettingsSectionId }
}

export type NavigationAction =
  | { type: 'open'; screen: Screen }
  | { type: 'open-inbox-request'; taskId: string; factoryId: string; requestId: string }
  | { type: 'open-factory'; factoryId: string }
  | { type: 'open-tasks'; factoryId: string }
  | { type: 'open-task'; taskId: string; factoryId?: string; requestId?: string }
  | { type: 'open-plan'; factoryId: string; planId?: string; from?: string; requestId?: string }
  | { type: 'close-task' }
  | {
      type: 'open-automation'
      automationId: string
      factoryId: string
      runId?: string
      requestId?: string
    }
  | { type: 'close-automation' }
  | { type: 'open-settings'; section?: SettingsSectionId }
  | { type: 'close-settings' }

export const newPlan = 'new'

export const initialNavigation: Navigation = {
  screen: { kind: 'inbox' },
  lastViews: {},
  lastTaskViews: {},
}

export function navigate(state: Navigation, action: NavigationAction): Navigation {
  switch (action.type) {
    case 'open': {
      const {
        taskId: _,
        requestId: ___,
        settings: __,
        automation: ____,
        planId: _____,
        planFrom: ______,
        ...rest
      } = state
      if (action.screen.kind !== 'factory') return { ...rest, screen: action.screen }
      const { factoryId, view } = action.screen
      return {
        ...rest,
        screen: action.screen,
        lastFactoryId: factoryId,
        lastViews: { ...state.lastViews, [factoryId]: view },
        ...(isTaskView(view) && {
          lastTaskViews: { ...state.lastTaskViews, [factoryId]: view },
        }),
      }
    }
    case 'open-factory': {
      const view = state.lastViews[action.factoryId]
      if (view === undefined)
        return {
          ...navigate(state, {
            type: 'open',
            screen: { kind: 'dashboard', dashboard: { factoryIds: [action.factoryId] } },
          }),
          lastFactoryId: action.factoryId,
        }
      return navigate(state, {
        type: 'open',
        screen: { kind: 'factory', factoryId: action.factoryId, view },
      })
    }
    case 'open-tasks': {
      const view = state.lastTaskViews[action.factoryId] ?? 'board'
      return navigate(state, {
        type: 'open',
        screen: { kind: 'factory', factoryId: action.factoryId, view },
      })
    }
    case 'open-plan': {
      if (
        state.screen.kind === 'inbox' &&
        action.planId !== undefined &&
        action.requestId !== undefined
      ) {
        return {
          ...navigate(state, { type: 'open', screen: state.screen }),
          planId: action.planId,
          requestId: action.requestId,
          lastFactoryId: action.factoryId,
        }
      }
      const opened = navigate(state, {
        type: 'open',
        screen: { kind: 'factory', factoryId: action.factoryId, view: 'plans' },
      })
      return {
        ...opened,
        planId: action.planId ?? newPlan,
        ...(action.requestId !== undefined && { requestId: action.requestId }),
        ...(action.planId === undefined && action.from !== undefined && { planFrom: action.from }),
      }
    }
    case 'open-inbox-request':
      return navigate(navigate(state, { type: 'open', screen: { kind: 'inbox' } }), {
        type: 'open-task',
        taskId: action.taskId,
        factoryId: action.factoryId,
        requestId: action.requestId,
      })
    case 'open-task': {
      const { requestId: _, automation: __, ...rest } = state
      const { planId: ___, planFrom: ____, ...withoutPlan } = rest
      return {
        ...(state.screen.kind === 'inbox' ? withoutPlan : rest),
        taskId: action.taskId,
        ...(action.requestId !== undefined && { requestId: action.requestId }),
        ...(action.factoryId !== undefined && { lastFactoryId: action.factoryId }),
      }
    }
    case 'close-task': {
      const { taskId: _, requestId: __, ...rest } = state
      return rest
    }
    case 'open-automation': {
      const automation = {
        id: action.automationId,
        ...(action.runId !== undefined && { runId: action.runId }),
      }
      if (state.screen.kind === 'inbox' && action.runId !== undefined) {
        const { taskId: _, requestId: __, planId: ___, planFrom: ____, ...rest } = state
        return {
          ...rest,
          automation,
          lastFactoryId: action.factoryId,
          ...(action.requestId !== undefined && { requestId: action.requestId }),
        }
      }
      const screen: Screen = { kind: 'factory', factoryId: action.factoryId, view: 'automations' }
      return { ...navigate(state, { type: 'open', screen }), automation }
    }
    case 'close-automation': {
      const { automation, requestId: _, ...rest } = state
      if (automation?.runId === undefined) return rest
      const factoryId =
        state.screen.kind === 'factory' ? state.screen.factoryId : state.lastFactoryId
      if (factoryId === undefined) return rest
      if (state.screen.kind === 'factory') return { ...rest, automation: { id: automation.id } }
      return navigate(rest, { type: 'open-automation', automationId: automation.id, factoryId })
    }
    case 'open-settings': {
      const section = action.section ?? state.settings?.section ?? 'general'
      return { ...state, settings: { section } }
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
  if (state.automation && state.lastFactoryId !== undefined) return state.lastFactoryId
  if (state.screen.kind === 'factory') return state.screen.factoryId
  return state.lastFactoryId
}

type Place = Pick<
  Navigation,
  'screen' | 'taskId' | 'requestId' | 'settings' | 'planId' | 'planFrom' | 'lastFactoryId'
>

export interface History {
  now: Navigation
  back: readonly Place[]
  forward: readonly Place[]
}

export type HistoryAction = NavigationAction | { type: 'back' } | { type: 'forward' }

const historyLimit = 100

export function startHistory(now: Navigation): History {
  return { now, back: [], forward: [] }
}

function placeOf({
  screen,
  taskId,
  requestId,
  settings,
  planId,
  planFrom,
  lastFactoryId,
}: Navigation): Place {
  return {
    screen,
    ...(taskId !== undefined && { taskId }),
    ...(requestId !== undefined && { requestId }),
    ...(settings !== undefined && { settings }),
    ...(planId !== undefined && {
      planId,
      ...(planFrom !== undefined && { planFrom }),
      ...(lastFactoryId !== undefined && { lastFactoryId }),
    }),
  }
}

function samePlace(a: Place, b: Place): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function goTo(state: Navigation, place: Place): Navigation {
  const { taskId: _, requestId: __, settings: ___, planId: ____, planFrom: _____, ...rest } = state
  const { screen } = place
  return {
    ...rest,
    ...place,
    ...(screen.kind === 'factory' && {
      lastFactoryId: screen.factoryId,
      lastViews: { ...state.lastViews, [screen.factoryId]: screen.view },
      ...(isTaskView(screen.view) && {
        lastTaskViews: { ...state.lastTaskViews, [screen.factoryId]: screen.view },
      }),
    }),
  }
}

export function withHistory(history: History, action: HistoryAction): History {
  const here = placeOf(history.now)
  if (action.type === 'back' || action.type === 'forward') {
    const from = action.type === 'back' ? history.back : history.forward
    const target = from.at(-1)
    if (target === undefined) return history
    const rest = from.slice(0, -1)
    const now = goTo(history.now, target)
    return action.type === 'back'
      ? { now, back: rest, forward: [...history.forward, here] }
      : { now, back: [...history.back, here], forward: rest }
  }
  const now = navigate(history.now, action)
  if (samePlace(placeOf(now), here)) return { ...history, now }
  return { now, back: [...history.back, here].slice(-historyLimit), forward: [] }
}

export function backLink(state: Navigation): string | undefined {
  if (state.taskId === undefined) return undefined
  const { screen } = state
  if (screen.kind === 'all-tasks') return '← All Tasks'
  if (screen.kind === 'dashboard') return '← Dashboard'
  if (screen.kind === 'factory' && screen.view === 'board') return '← Board'
  if (screen.kind === 'factory' && screen.view === 'list') return '← List'
  if (screen.kind === 'factory' && screen.view === 'map') return '← Map'
  if (screen.kind === 'factory' && screen.view === 'coordinator') return '← Coordinator'
  return undefined
}
