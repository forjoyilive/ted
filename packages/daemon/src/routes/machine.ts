import {
  agentKinds,
  agentStageIds,
  appearances,
  archivedFilters,
  type BannerActionInput,
  billings,
  createdByKinds,
  editorIds,
  type ListFilters,
  type ListView,
  listColumns,
  listGroups,
  listSorts,
  type MachineSettings,
  priorities,
  quitChoices,
  type StatusFilter,
  simulatorSlotLimits,
  taskStatusKinds,
  terminalFontSizes,
  workingRunLimits,
} from '@ted/protocol'
import { parseEditorCommand } from '../editors.ts'
import { RequestError as HttpError } from '../errors.ts'
import { readProfile } from '../profile.ts'
import { type Route, readJson, readOptionalJson } from './route.ts'

export const machineRoutes: Route[] = [
  {
    method: 'GET',
    path: /^\/settings$/,
    handle: async (_, { store }) => [200, store.settings()],
  },
  {
    method: 'PATCH',
    path: /^\/settings$/,
    async handle({ req }, { store }) {
      return [200, store.updateSettings(settingsChanges(await readJson(req)))]
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
      { checks: store.activity().checksRunning, merges: tasks.mergesInFlight() },
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
  {
    method: 'POST',
    path: /^\/banners\/([^/]+)\/action$/,
    async handle({ req, params: [id = ''] }, { banners }) {
      const body = (await readOptionalJson(req)) as Partial<BannerActionInput> | null
      const folder = typeof body?.folder === 'string' ? body.folder : undefined
      await banners.act(id, folder === undefined ? {} : { folder })
      return [200, {}]
    },
  },
  {
    method: 'GET',
    path: /^\/storage$/,
    handle: async (_, { storage }) => [200, await storage.summary()],
  },
  {
    method: 'POST',
    path: /^\/storage\/remove-clones$/,
    handle: async (_, { storage }) => [200, await storage.removeUnusedClones()],
  },
]

function settingsChanges(body: unknown): Partial<MachineSettings> {
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
  const columns = oneOfList('columns', view.columns, listColumns)
  return {
    sort,
    group,
    columns: columns.includes('title') ? columns : ['title', ...columns],
    filters: listFilters(view.filters ?? {}),
  }
}

const settingParsers: { [K in keyof MachineSettings]: (value: unknown) => MachineSettings[K] } = {
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
  appearance(value) {
    const appearance = appearances.find((a) => a === value)
    if (!appearance) throw new HttpError(400, `appearance must be ${appearances.join(', ')}`)
    return appearance
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
  quitWithWorkRunning(value) {
    const choice = quitChoices.find((c) => c === value)
    if (!choice) throw new HttpError(400, `quitWithWorkRunning must be ${quitChoices.join(', ')}`)
    return choice
  },
  showTrayIcon: onOff('showTrayIcon'),
  startAtLogin: onOff('startAtLogin'),
  stayAwake: onOff('stayAwake'),
  restartIdleRuns: onOff('restartIdleRuns'),
  notifyInboxItems: onOff('notifyInboxItems'),
  notifyProblems: onOff('notifyProblems'),
  notifyTaskMerged: onOff('notifyTaskMerged'),
  notifySound: onOff('notifySound'),
  firstLaunchDone: onOff('firstLaunchDone'),
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
    return { claude: choose('claude'), codex: choose('codex') }
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

function onOff(name: keyof MachineSettings): (value: unknown) => boolean {
  return (value) => {
    if (typeof value !== 'boolean') throw new HttpError(400, `${name} must be true or false`)
    return value
  }
}
