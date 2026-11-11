import type { Factory, InboxItem, MachineSettings, RunSlots, Task } from '@ted/protocol'
import { defaultMachineSettings } from '@ted/protocol/settings'
import { act, render, screen, within } from '@testing-library/react'
import { App } from '../../src/renderer/App.tsx'
import { bridge, user } from './component.ts'
import { factory } from './fixtures.ts'

export function appState() {
  const state: {
    factories: Factory[]
    tasks: Task[]
    inbox: InboxItem[]
    settings: MachineSettings
    slots: RunSlots
  } = {
    factories: [factory()],
    tasks: [],
    inbox: [],
    settings: { ...defaultMachineSettings, firstLaunchDone: true },
    slots: { limit: 3, working: 0, queued: 0, holders: [], queue: [], factories: [] },
  }
  const api = bridge({
    listFactories: () => state.factories,
    listTasks: () => state.tasks,
    listInbox: () => state.inbox,
    listAnswered: () => [],
    listWaiting: () => [],
    listBanners: () => [],
    listPlans: () => [],
    coordinatorStatuses: () => [],
    planInbox: () => [],
    automationRequests: () => [],
    listAutomations: () => [],
    agentHealth: () => [],
    checkAgentHealth: () => [],
    taskDraft: () => ({ draft: null }),
    saveTaskDraft: (_factory, draft) => ({ draft }),
    getSlots: () => state.slots,
    drift: () => ({ library: 0, factories: {} }),
    simulators: () => ({ supported: false, limit: 2, booted: [] }),
    getSettings: () => state.settings,
    notificationsOff: () => false,
    updateStatus: () => ({ state: 'unavailable' }),
    getProfile: () => ({ name: 'Nabha Cosley' }),
    getCommandLine: () => ({ state: 'unavailable' }),
    loginItem: () => 'unavailable',
    foundEditors: () => [],
    listEditors: () => [],
    taskDefaults: () => ({ lead: { agent: 'claude' }, clarifyDepth: 'auto' }),
    factoryBoard: () => ({
      stages: [
        { id: 'intake', gate: false },
        { id: 'work', gate: false },
        { id: 'review', gate: true },
      ],
    }),
    updateSettings: (changes) => {
      state.settings = { ...state.settings, ...(changes as Partial<MachineSettings>) }
      api.emit({ type: 'settings-changed', settings: state.settings })
      return state.settings
    },
    taskGates: () => ({ rows: [], overrides: {}, revision: 'v1' }),
    listComments: () => [],
    listThreadEvents: () => [],
    listCheckRuns: () => [],
    listTaskRuns: () => [],
    taskBrief: () => null,
    taskDescriptions: () => [],
    taskChanges: () => ({ repos: [] }),
    taskFiles: (taskId) => ({ taskId, repos: [] }),
    lineComments: () => [],
    listApps: () => [],
    listStageEntries: () => [],
  })
  return {
    state,
    ...api,
    mount: (props: { addFactoryFirst?: boolean } = {}) => render(<App {...props} />),
    async settings() {
      const nav = await screen.findByRole('navigation', { name: 'Sidebar' })
      await user().click(within(nav).getByRole('button', { name: /^Settings/ }))
    },
    async emitTask(task: Task) {
      state.tasks = [...state.tasks.filter((t) => t.id !== task.id), task]
      await act(async () => api.emit({ type: 'task-updated', task }))
    },
  }
}
