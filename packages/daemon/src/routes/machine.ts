import {
  agentKinds,
  agentStageIds,
  appearances,
  archivedFilters,
  type BoardView,
  billings,
  boardCardSizes,
  boardFields,
  checkLimits,
  createdByKinds,
  editorIds,
  emulatorSlotLimits,
  isLinearIntakeScope,
  isLinearTeamKey,
  isTimeZone,
  type ListFilters,
  type ListView,
  listColumns,
  listGroups,
  listSorts,
  type MachineSettings,
  parseBannerActionInput,
  parseChangeAgentAvailabilityRequest,
  priorities,
  quitChoices,
  runOutputDayLimits,
  type StatusFilter,
  simulatorSlotLimits,
  taskStatusKinds,
  terminalFontSizes,
  textSizeLimits,
  timeFormats,
  workingRunLimits,
} from '@ted/protocol'
import { parseEditorCommand } from '../editors.ts'
import { RequestError as HttpError } from '../errors.ts'
import { readProfile } from '../profile.ts'
import { jsonRoute, type Route, readJson } from './route.ts'

export const machineRoutes: Route[] = [
  {
    method: 'GET',
    path: /^\/agents\/availability$/,
    handle: async ({ caller }, { agentAvailability }) => {
      if (caller.kind !== 'app')
        throw new HttpError(403, 'Only the app can inspect agent availability')
      return [200, agentAvailability.list()]
    },
  },
  jsonRoute(parseChangeAgentAvailabilityRequest, {
    method: 'POST',
    path: /^\/agents\/availability$/,
    handle: async ({ body }, { agentAvailability }) => [200, await agentAvailability.change(body)],
  }),
  {
    method: 'GET',
    path: /^\/settings$/,
    handle: async (_, { store }) => [200, store.settings()],
  },
  {
    method: 'PATCH',
    path: /^\/settings$/,
    async handle({ req }, { store }) {
      return [200, store.updateSettings(settingsChanges(await readJson(req), store.settings()))]
    },
  },
  {
    method: 'GET',
    path: /^\/activity$/,
    handle: async (_, { store }) => [200, store.activity()],
  },
  {
    method: 'GET',
    path: /^\/update\/work$/,
    handle: async (_, { store, tasks }) => [
      200,
      {
        checks: store.activity().checksRunning + store.activity().checksWaiting,
        merges: tasks.mergesInFlight(),
      },
    ],
  },
  {
    method: 'GET',
    path: /^\/profile$/,
    handle: async () => [200, await readProfile()],
  },
  {
    method: 'GET',
    path: /^\/banners$/,
    handle: async (_, { banners }) => [200, banners.list()],
  },
  {
    method: 'POST',
    path: /^\/banners\/([^/]+)\/dismiss$/,
    handle: async ({ params: [id = ''] }, { banners }) => [200, banners.dismiss(id)],
  },
  jsonRoute(parseBannerActionInput, {
    optionalBody: true,
    method: 'POST',
    path: /^\/banners\/([^/]+)\/action$/,
    async handle({ body, params: [id = ''] }, { banners }) {
      await banners.act(id, body)
      return [200, {}]
    },
  }),
  {
    method: 'GET',
    path: /^\/storage(?:\?.*)?$/,
    handle: async ({ req }, { storage }) => {
      const refresh = new URL(req.url ?? '/', 'http://localhost').searchParams.get('refresh')
      return [200, await storage.summary({ refresh: refresh === '1' })]
    },
  },
  {
    method: 'POST',
    path: /^\/storage\/viewed$/,
    handle: async (_, { storage }) => {
      storage.viewed()
      return [200, {}]
    },
  },
  {
    method: 'POST',
    path: /^\/storage\/remove-clones$/,
    handle: async (_, { storage }) => [200, await storage.removeUnusedClones()],
  },
]

function settingsChanges(body: unknown, current: MachineSettings): Partial<MachineSettings> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'settings must be an object')
  }
  const entries = Object.entries(body)
  if (entries.length === 0) throw new HttpError(400, 'no settings to change')
  const changes: Partial<MachineSettings> = {}
  for (const [name, value] of entries) {
    if (!Object.hasOwn(settingParsers, name)) throw new HttpError(400, `unknown setting ${name}`)
    Object.assign(changes, { [name]: settingParsers[name as keyof MachineSettings](value) })
  }
  for (const name of ['trackerSyncGroups', 'trackerSyncDeclined'] as const) {
    const lists = changes[name]
    if (lists && JSON.stringify(lists.asana ?? {}) !== JSON.stringify(current[name].asana ?? {})) {
      throw new HttpError(400, 'Change Asana projects through Settings → Integrations → Asana')
    }
  }
  return changes
}

const maxPictureBytes = 512 * 1024

const pictureUrl = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/

const stageIds = ['backlog', ...agentStageIds, 'done'] as const

const statusFilters: readonly StatusFilter[] = [...taskStatusKinds, 'none']

function oneOfList<T extends string>(name: string, value: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(value)) throw new HttpError(400, `${name} must be a list`)
  return value.map((item) => {
    const found = allowed.find((a) => a === item)
    if (!found) throw new HttpError(400, `${name} must list only ${allowed.join(', ')}`)
    return found
  })
}

function listFilters(value: unknown): ListFilters {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'filters must be an object')
  }
  const given = value as Record<string, unknown>
  const filters: ListFilters = {}
  for (const [name, item] of Object.entries(given)) {
    if (name === 'factories') {
      if (!Array.isArray(item) || item.some((f) => typeof f !== 'string')) {
        throw new HttpError(400, 'factories must list Factory IDs')
      }
      filters.factories = item as string[]
    } else if (name === 'stages') filters.stages = oneOfList(name, item, stageIds)
    else if (name === 'statuses') filters.statuses = oneOfList(name, item, statusFilters)
    else if (name === 'priorities') filters.priorities = oneOfList(name, item, priorities)
    else if (name === 'createdBy') filters.createdBy = oneOfList(name, item, createdByKinds)
    else if (name === 'needsPlanning') {
      if (typeof item !== 'boolean') throw new HttpError(400, 'needsPlanning must be true or false')
      filters.needsPlanning = item
    } else if (name === 'archived') {
      const archived = archivedFilters.find((a) => a === item)
      if (!archived) throw new HttpError(400, `archived must be ${archivedFilters.join(', ')}`)
      filters.archived = archived
    } else throw new HttpError(400, `unknown filter ${name}`)
  }
  return filters
}

function listView(value: unknown): ListView {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'a List view must be an object')
  }
  const view = value as Record<string, unknown>
  const sort = listSorts.find((s) => s === view.sort)
  if (!sort) throw new HttpError(400, `sort must be ${listSorts.join(', ')}`)
  const group = listGroups.find((g) => g === view.group)
  if (!group) throw new HttpError(400, `group must be ${listGroups.join(', ')}`)
  if (view.showEmptyGroups !== undefined && typeof view.showEmptyGroups !== 'boolean') {
    throw new HttpError(400, 'showEmptyGroups must be true or false')
  }
  if (view.nested !== undefined && typeof view.nested !== 'boolean') {
    throw new HttpError(400, 'nested must be true or false')
  }
  const columns = oneOfList('columns', view.columns, listColumns)
  if (view.columnsVersion !== undefined && view.columnsVersion !== 2) {
    throw new HttpError(400, 'columnsVersion must be 2')
  }
  return {
    sort,
    group,
    ...(view.columnsVersion === 2 && { columnsVersion: 2 }),
    columns: columns.includes('title') ? columns : ['title', ...columns],
    filters: listFilters(view.filters ?? {}),
    ...(view.showEmptyGroups !== undefined && { showEmptyGroups: view.showEmptyGroups }),
    ...(view.nested !== undefined && { nested: view.nested }),
  }
}

function boardView(value: unknown): BoardView {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'a Board view must be an object')
  }
  const view = value as Record<string, unknown>
  const cardSize = boardCardSizes.find((s) => s === view.cardSize)
  if (!cardSize) throw new HttpError(400, `cardSize must be ${boardCardSizes.join(', ')}`)
  if (typeof view.hideEmpty !== 'boolean') {
    throw new HttpError(400, 'hideEmpty must be true or false')
  }
  return {
    cardSize,
    fields: [...new Set(oneOfList('fields', view.fields, boardFields))],
    hiddenStages: [...new Set(oneOfList('hiddenStages', view.hiddenStages, stageIds))],
    hideEmpty: view.hideEmpty,
  }
}

const settingParsers: { [K in keyof MachineSettings]: (value: unknown) => MachineSettings[K] } = {
  enabledAgents() {
    throw new HttpError(
      400,
      'Change agents through Settings → Agents so existing Runs are accounted for.',
    )
  },
  timeFormat(value) {
    const format = timeFormats.find((format) => format === value)
    if (!format) throw new HttpError(400, `timeFormat must be ${timeFormats.join(', ')}`)
    return format
  },
  timeZone(value) {
    if (typeof value !== 'string' || (value !== 'system' && !isTimeZone(value))) {
      throw new HttpError(400, 'timeZone must be system or a valid IANA time zone')
    }
    return value
  },
  listViews(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new HttpError(400, 'listViews must be an object of List views by scope')
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([scope, view]) => [
        scope,
        listView(view),
      ]),
    )
  },
  boardViews(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new HttpError(400, 'boardViews must be an object of Board views by Factory')
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([factoryId, view]) => [
        factoryId,
        boardView(view),
      ]),
    )
  },
  appearance(value) {
    const appearance = appearances.find((a) => a === value)
    if (!appearance) throw new HttpError(400, `appearance must be ${appearances.join(', ')}`)
    return appearance
  },
  textSize(value) {
    const { min, max, step } = textSizeLimits
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < min ||
      value > max ||
      value % step !== 0
    ) {
      throw new HttpError(400, `textSize must be from ${min} to ${max} in steps of ${step}`)
    }
    return value
  },
  terminalFontSize(value) {
    const { min, max } = terminalFontSizes
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new HttpError(400, `terminalFontSize must be a whole number from ${min} to ${max}`)
    }
    return value
  },
  profilePicture(value) {
    if (value === null) return null
    if (typeof value !== 'string' || value.length > maxPictureBytes || !pictureUrl.test(value)) {
      throw new HttpError(
        400,
        'profilePicture must be a PNG or JPEG data URL under 512 KB, or null',
      )
    }
    return value
  },
  developerMode(value) {
    if (typeof value !== 'boolean') throw new HttpError(400, 'developerMode must be true or false')
    return value
  },
  maxWorkingRuns(value) {
    const { min, max } = workingRunLimits
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new HttpError(400, `maxWorkingRuns must be a whole number from ${min} to ${max}`)
    }
    return value
  },
  maxBootedSimulators(value) {
    const { min, max } = simulatorSlotLimits
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new HttpError(400, `maxBootedSimulators must be a whole number from ${min} to ${max}`)
    }
    return value
  },
  maxRunningEmulators(value) {
    const { min, max } = emulatorSlotLimits
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new HttpError(400, `maxRunningEmulators must be a whole number from ${min} to ${max}`)
    }
    return value
  },
  runOutputDays(value) {
    const { min, max } = runOutputDayLimits
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new HttpError(400, `runOutputDays must be a whole number from ${min} to ${max}`)
    }
    return value
  },
  quitWithWorkRunning(value) {
    const choice = quitChoices.find((c) => c === value)
    if (!choice) throw new HttpError(400, `quitWithWorkRunning must be ${quitChoices.join(', ')}`)
    return choice
  },
  preparationNoticeSeen: onOff('preparationNoticeSeen'),
  overnightMode: onOff('overnightMode'),
  adjustRunsToLoad: onOff('adjustRunsToLoad'),
  showTrayIcon: onOff('showTrayIcon'),
  startAtLogin: onOff('startAtLogin'),
  stayAwake: onOff('stayAwake'),
  restartIdleRuns: onOff('restartIdleRuns'),
  notifyInboxItems: onOff('notifyInboxItems'),
  notifyProblems: onOff('notifyProblems'),
  notifyTaskMerged: onOff('notifyTaskMerged'),
  notifySound: onOff('notifySound'),
  factoryNotifications() {
    throw new HttpError(400, 'Change a Factory’s notifications through its own route')
  },
  firstLaunchDone: onOff('firstLaunchDone'),
  linearIntakeScopes(value) {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.entries(value).some(([id, scope]) => !id || !isLinearIntakeScope(scope))
    ) {
      throw new HttpError(400, 'linearIntakeScopes must contain a valid Linear scope per Factory')
    }
    return value as MachineSettings['linearIntakeScopes']
  },
  asanaIntakeScopes() {
    throw new HttpError(400, 'Change a Factory’s Asana intake through its own route')
  },
  githubIntakeScopes() {
    throw new HttpError(400, 'Change a Factory’s GitHub intake through its own route')
  },
  linearSync: onOff('linearSync'),
  asanaSync: onOff('asanaSync'),
  lowPriorityWork: onOff('lowPriorityWork'),
  antigravityPlanAccepted: onOff('antigravityPlanAccepted'),
  startNewTasks: onOff('startNewTasks'),
  maxChecksAtOnce(value) {
    const { min, max } = checkLimits
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new HttpError(400, `maxChecksAtOnce must be a whole number from ${min} to ${max}`)
    }
    return value
  },
  linearSyncTeams: (value) => teamsByFactory('linearSyncTeams', value),
  linearSyncDeclined: (value) => teamsByFactory('linearSyncDeclined', value),
  trackerSyncGroups: (value) => groupsByTracker('trackerSyncGroups', value),
  trackerSyncDeclined: (value) => groupsByTracker('trackerSyncDeclined', value),
  trackerSyncGroupAccounts() {
    throw new HttpError(400, 'TED records which account allowed a group itself')
  },
  factoryPermissions() {
    throw new HttpError(400, 'Change permission mode through Factory settings on this computer')
  },
  appsOutsideSandbox(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new HttpError(400, 'appsOutsideSandbox must be an object of App names by Factory ID')
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([factoryId, names]) => {
        if (
          !Array.isArray(names) ||
          names.length > 100 ||
          names.some((n) => typeof n !== 'string' || n.trim() === '' || n.length > 200)
        ) {
          throw new HttpError(400, 'appsOutsideSandbox lists App names for each Factory')
        }
        return [factoryId, [...new Set(names.map((n: string) => n.trim()))]]
      }),
    )
  },
  billing(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new HttpError(400, 'billing must be an object of billing by agent')
    }
    const given = value as Record<string, unknown>
    for (const name of Object.keys(given)) {
      if (!agentKinds.some((k) => k === name)) throw new HttpError(400, `unknown agent ${name}`)
    }
    const choose = (agent: (typeof agentKinds)[number]) => {
      const billing = billings.find((b) => b === given[agent])
      if (!billing) throw new HttpError(400, `billing.${agent} must be ${billings.join(', ')}`)
      return billing
    }
    return {
      claude: choose('claude'),
      codex: choose('codex'),
      antigravity: given.antigravity === undefined ? 'subscription' : choose('antigravity'),
    }
  },
  editor(value) {
    if (value === null || value === 'custom') return value
    const editor = editorIds.find((id) => id === value)
    if (!editor) throw new HttpError(400, `editor must be null, custom or ${editorIds.join(', ')}`)
    return editor
  },
  editorCommand(value) {
    if (typeof value !== 'string' || value.length > maxEditorCommand) {
      throw new HttpError(
        400,
        `editorCommand must be text of at most ${maxEditorCommand} characters`,
      )
    }
    try {
      parseEditorCommand(value)
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error))
    }
    return value.trim()
  },
}

const maxEditorCommand = 2000

function teamsByFactory(name: string, value: unknown): Record<string, string[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, `${name} must be an object of team keys by Factory ID`)
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([factoryId, teams]) => {
      if (
        !Array.isArray(teams) ||
        teams.length > 50 ||
        teams.some((t) => typeof t !== 'string' || !isLinearTeamKey(t))
      ) {
        throw new HttpError(400, `${name} lists Linear team keys like ENG for each Factory`)
      }
      return [factoryId, [...new Set(teams.map((t: string) => t.toUpperCase()))]]
    }),
  )
}

function groupsByTracker(name: string, value: unknown): Record<string, Record<string, string[]>> {
  const problem = `${name} must list group IDs by Factory ID for each tracker`
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
  if (!isObject(value)) throw new HttpError(400, problem)
  return Object.fromEntries(
    Object.entries(value).map(([tracker, byFactory]) => {
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(tracker) || !isObject(byFactory)) {
        throw new HttpError(400, problem)
      }
      const lists = Object.entries(byFactory).map(([factoryId, groups]) => {
        if (
          !Array.isArray(groups) ||
          groups.length > 100 ||
          groups.some((g) => typeof g !== 'string' || g.trim() === '' || g.length > 200)
        ) {
          throw new HttpError(400, problem)
        }
        return [factoryId, [...new Set(groups.map((g: string) => g.trim()))]]
      })
      return [tracker, Object.fromEntries(lists)]
    }),
  )
}

function onOff(name: keyof MachineSettings): (value: unknown) => boolean {
  return (value) => {
    if (typeof value !== 'boolean') throw new HttpError(400, `${name} must be true or false`)
    return value
  }
}
