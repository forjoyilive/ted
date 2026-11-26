import type {
  Attachment,
  AttachmentRef,
  Factory,
  FactoryLayout,
  InboxItem,
  MachineSettings,
  RunSlots,
  Task,
} from '@ted/protocol'
import { defaultMachineSettings } from '@ted/protocol/settings'
import { noChecks } from '@ted/protocol/slots'
import { defaultStageList } from '@ted/protocol/stage-list'
import { act, render, screen, within } from '@testing-library/react'
import { App, type AppStart } from '../../src/renderer/App.tsx'
import { bridge, user } from './component.ts'
import { dashboardFixture } from './dashboard.ts'
import { factory } from './fixtures.ts'

function sized(attachments: AttachmentRef[]): Attachment[] {
  return attachments.map((attachment) => ({ ...attachment, size: 0 }))
}

export function appState() {
  const state: {
    factories: Factory[]
    layout: FactoryLayout
    tasks: Task[]
    inbox: InboxItem[]
    settings: MachineSettings
    slots: RunSlots
  } = {
    factories: [factory()],
    layout: { items: [] },
    tasks: [],
    inbox: [],
    settings: { ...defaultMachineSettings, firstLaunchDone: true, reportingAsked: true },
    slots: {
      limit: 3,
      working: 0,
      queued: 0,
      holders: [],
      queue: [],
      factories: [],
      checks: noChecks,
    },
  }
  const api = bridge(
    {},
    {
      dashboard: () => dashboardFixture(true),
      listFactories: () => state.factories,
      factoryLayout: () => state.layout,
      listTasks: () => state.tasks,
      listInbox: () => state.inbox,
      listAnswered: () => [],
      listWaiting: () => [],
      listSnoozed: () => [],
      listBanners: () => [],
      listPlans: () => [],
      coordinatorStatuses: () => [],
      coordinatorChats: () => [],
      planInbox: () => [],
      automationRequests: () => [],
      listAutomations: () => [],
      agentHealth: () => [],
      apiCost: () => ({ days: 30, since: '2026-10-12T00:00:00.000Z', agents: [] }),
      checkAgentHealth: () => [],
      taskDraft: () => ({ draft: null }),
      saveTaskDraft: (_factory, draft) => ({
        draft: { ...draft, attachments: sized(draft.attachments) },
      }),
      messageDraft: () => ({ draft: null }),
      saveMessageDraft: (_box, draft) => ({
        draft: { ...draft, attachments: sized(draft.attachments) },
      }),
      getSlots: () => state.slots,
      drift: () => ({ library: 0, factories: {} }),
      simulators: () => ({ supported: false, limit: 2, booted: [], waiting: [] }),
      emulators: () => ({ supported: false, limit: 2, booted: [], waiting: [] }),
      getSettings: () => state.settings,
      getLinear: () => ({ state: 'no-key', keyring: 'macos-keychain' }),
      notificationsOff: () => false,
      notificationOffer: () => 'done',
      updateStatus: () => ({ state: 'unavailable' }),
      getProfile: () => ({ name: 'Nabha Cosley' }),
      getCommandLine: () => ({ state: 'unavailable' }),
      loginItem: () => 'unavailable',
      startSettled: () => undefined,
      listEditors: () => [],
      taskDefaults: () => ({
        lead: { agent: 'claude' },
        planner: { agent: 'claude' },
        clarifyDepth: 'auto',
      }),
      factoryBoard: () => ({ stages: [...defaultStageList] }),
      updateSettings: (changes) => {
        state.settings = { ...state.settings, ...changes }
        api.emit({ type: 'settings-changed', settings: state.settings })
        return state.settings
      },
      listComments: () => [],
      listThreadEvents: () => [],
      listFailures: () => [],
      validationObligations: () => ({ satisfied: true, cases: [], blockers: [], checkRuns: [] }),
      listCheckRuns: () => [],
      listTaskRuns: () => [],
      taskBrief: () => null,
      taskDescriptions: () => [],
      taskChanges: (taskId) => ({ taskId, files: 0, repos: [] }),
      taskFiles: (taskId) => ({ taskId, repos: [] }),
      taskCommits: () => [],
      lineComments: () => [],
      listApps: () => [],
      listStageEntries: () => [],
      taskGates: () => ({ overrides: {}, rows: [], revision: 'gates-1' }),
    },
  )
  return {
    state,
    ...api,
    mount: (props: { start?: AppStart } = {}) => render(<App {...props} />),
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
