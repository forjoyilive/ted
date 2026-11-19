import { randomBytes } from 'node:crypto'
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  type AgentChoiceInput,
  type AgentKind,
  type AgentStageId,
  agentKinds,
  agentRoles,
  type ClarifyDepth,
  type DaemonEvent,
  type Effort,
  type LibraryAgentRow,
  type LibraryChanges,
  type LibraryInvalid,
  type LibraryPreview,
  type LibraryStageRow,
  type LibraryView,
  type SaveLibraryRequest,
  type WorkflowProblem,
} from '@ted/protocol'
import { fileChange } from '@ted/protocol/diff'
import {
  handsOff,
  hasClarifyRounds,
  isBuiltInStage,
  isCleanup,
  mergesHere,
  settingsStageOrder,
  stageEnabled,
  stageFileId,
  validates,
} from '@ted/protocol/stage'
import { RequestError } from './errors.ts'
import type { TedStore } from './store/index.ts'
import { resolveAgentChoices } from './workflow/agent-choices.ts'
import { agentFileRows, applyAgentChanges } from './workflow/agent-edit.ts'
import { agentFileId, resolveAgents } from './workflow/agent-files.ts'
import { type CheckedLayer, checkLayer, type LayerFiles } from './workflow/check.ts'
import { driftView, findDrift } from './workflow/drift.ts'
import { applyChanges } from './workflow/edit.ts'
import {
  contentVersion,
  readDefaultLayer,
  readLayerDirectory,
  sameFiles,
  stageFileHash,
} from './workflow/layers.ts'
import { resolveWorkflow } from './workflow/resolve.ts'
import type { Workflows } from './workflow/workflows.ts'

export interface LibrarySettings {
  view(): Promise<LibraryView>
  preview(changes: LibraryChanges): Promise<LibraryPreview>
  save(request: SaveLibraryRequest): Promise<LibraryView>
}

export interface LibrarySettingsOptions {
  store: TedStore
  workflows: Pick<Workflows, 'inherited'>
  libraryDir: string
  installed: (agent: AgentKind) => boolean
  emit: (event: DaemonEvent) => void
  saved?: (version: string) => void
}

interface Base {
  current: LayerFiles
  files: LayerFiles
  text: string | undefined
  version: string
  problems: WorkflowProblem[]
  defaults: CheckedLayer
  own: CheckedLayer
}

const knownFile = (file: string) =>
  file === 'workflow.yaml' ||
  file === 'agents.yaml' ||
  stageFileId(file) !== undefined ||
  agentFileId(file) !== undefined

const library = (files: LayerFiles) => checkLayer({ kind: 'library', files })

export function createLibrarySettings(options: LibrarySettingsOptions): LibrarySettings {
  const { store, libraryDir } = options
  let saving = false
  let lastChecked: { files: LayerFiles; layer: CheckedLayer } | undefined

  function check(files: LayerFiles): CheckedLayer {
    if (!lastChecked || !sameFiles(lastChecked.files, files)) {
      lastChecked = { files, layer: library(files) }
    }
    return lastChecked.layer
  }

  async function load(): Promise<Base> {
    const current = (await readLayerDirectory(libraryDir)) ?? {}
    const checked = check(current)
    const files = checked.valid ? current : (store.lastValidWorkflowLayer('library')?.files ?? {})
    const workflowText = files['workflow.yaml']
    return {
      current,
      files,
      text: typeof workflowText === 'string' ? workflowText : undefined,
      version: contentVersion(current),
      problems: checked.problems,
      defaults: await readDefaultLayer(),
      own: checked.valid ? checked : library(files),
    }
  }

  function edited(
    base: Base,
    changes: LibraryChanges,
  ): { problems: WorkflowProblem[]; files: Record<string, string | null> } {
    const defaults = resolveWorkflow([base.defaults])
    const basedOn: Partial<Record<AgentStageId, string | null>> = {}
    const after: LayerFiles = Object.fromEntries(
      Object.entries(base.files).filter(([name]) => knownFile(name)),
    )
    for (const [id, text] of Object.entries(changes.stageFiles ?? {}) as [
      AgentStageId,
      string | null | undefined,
    ][]) {
      if (text === undefined) continue
      const file = `stages/${id}.md`
      if (text === null) {
        if (after[file] !== undefined) basedOn[id] = null
        delete after[file]
        continue
      }
      if (typeof after[file] !== 'string') {
        const from = defaults.stageFile(id)
        if (from) basedOn[id] = stageFileHash(from.text)
      }
      after[file] = text
    }
    for (const id of changes.keepStageFiles ?? []) {
      const from = defaults.stageFile(id)
      if (typeof after[`stages/${id}.md`] === 'string' && from && basedOn[id] === undefined) {
        basedOn[id] = stageFileHash(from.text)
      }
    }
    const touchesYaml =
      Object.keys(basedOn).length > 0 ||
      Object.keys(changes.stages ?? {}).length > 0 ||
      Object.keys(changes.agents ?? {}).length > 0
    if (touchesYaml) after['workflow.yaml'] = applyChanges(base.text, changes, [], basedOn)
    applyAgentChanges(after, changes, resolveAgents([base.defaults]))
    const errors = library(after).problems.filter((p) => p.severity === 'error')
    if (errors.length > 0) return { problems: errors, files: {} }
    const writes: Record<string, string | null> = {}
    const names = new Set([...Object.keys(after), ...Object.keys(base.current)])
    for (const name of [...names].filter(knownFile).sort(fileOrder)) {
      const next = after[name] ?? null
      const before = base.current[name]
      if (before === undefined && next === null) continue
      if (next !== before) writes[name] = next
    }
    return { problems: [], files: writes }
  }

  function stageRows(base: Base): LibraryStageRow[] {
    const { own } = base
    const defaults = resolveWorkflow([base.defaults])
    const full = resolveWorkflow([base.defaults, own])
    const drifts = findDrift([base.defaults], own)
    const ids = settingsStageOrder(full.order)
    const { overnightMode } = store.settings()
    return ids.map((id) => {
      const stage = full.settings.stages[id]
      const agent = id !== 'backlog' && id !== 'done' ? id : undefined
      const inOrder = agent === undefined || isCleanup(id) || full.order.includes(agent)
      const libraryFile = agent ? own.stageFiles[agent] : undefined
      const defaultText = agent ? defaults.stageFile(agent)?.text : undefined
      const basedOn = own.settings.stages[id]?.based_on
      const drift = drifts.find((d) => d.stage === id)
      return {
        id,
        name: full.name(id),
        ...(!isBuiltInStage(id) && { custom: true as const }),
        inOrder,
        enabled: stageEnabled(id, inOrder, stage?.enabled),
        gate: stage?.gate === true,
        ...(agent && {
          effort: (own.settings.stages[id]?.effort ?? null) as Effort | null,
          ...(defaults.settings.stages[id]?.effort !== undefined && {
            inheritedEffort: defaults.settings.stages[id]?.effort as Effort,
          }),
          inheritedEffortFrom: 'ted' as const,
        }),
        ...(agent && stage?.gate === true && overnightMode && { overnight: true as const }),
        ...(stage?.max_back !== undefined && agent && { maxBack: stage.max_back }),
        ...(hasClarifyRounds(id) && { depth: (stage?.depth ?? 'auto') as ClarifyDepth }),
        ...(validates(id) && {
          p1OnlyFrom: stage?.p1_only_from ?? false,
          subAgents: stage?.sub_agents === true,
        }),
        ...(handsOff(id) && { leadClosesFailures: stage?.lead_closes_failures === true }),
        ...(mergesHere(id) && { commitTitles: stage?.commit_titles !== false }),
        from: libraryFile !== undefined ? 'library' : 'ted',
        ...(libraryFile !== undefined && { libraryFile }),
        ...(defaultText !== undefined && { defaultText }),
        ...(basedOn !== undefined && { basedOn }),
        ...(drift && { drift: driftView(drift, (hash) => store.seenStageFileText(hash)) }),
      }
    })
  }

  function agentRows(base: Base): LibraryAgentRow[] {
    const own = base.own.settings
    const defaults = base.defaults.settings
    const merged = resolveWorkflow([base.defaults, base.own]).settings
    const installed = Object.fromEntries(agentKinds.map((kind) => [kind, options.installed(kind)]))
    return agentRoles.map((role) => {
      const choice = own[role]
      const resolved = resolveAgentChoices(
        { ...merged, [role]: defaults[role] } as typeof merged,
        installed,
        options.store.settings().enabledAgents,
        options.store.agentPauses(),
      )
      return {
        role,
        ...(choice && { own: choiceInput(choice) }),
        default: choiceInput({
          ...defaults[role],
          agent: defaults[role]?.agent ?? resolved[role].agent,
        }),
        from: choice ? 'library' : 'ted',
      }
    })
  }

  function invalid(base: Base): LibraryInvalid | undefined {
    const error = base.problems.find((p) => p.severity === 'error')
    if (!error) return undefined
    const last = store.lastValidWorkflowLayer('library')
    return {
      file: error.file,
      line: error.line,
      column: error.column,
      message: error.message,
      ...(last && { lastValid: { version: last.version, at: last.acceptedAt } }),
    }
  }

  async function view(): Promise<LibraryView> {
    const [base] = await Promise.all([load(), options.workflows.inherited()])
    const problem = invalid(base)
    return {
      path: libraryDir,
      version: base.version,
      stages: stageRows(base),
      agents: agentRows(base),
      agentFiles: agentFileRows([base.defaults], base.own),
      problems: base.problems,
      ...(problem && { invalid: problem }),
    }
  }

  async function plainTarget(name: string): Promise<string> {
    const parts = name.split('/')
    let folder = libraryDir
    for (const part of [undefined, ...parts.slice(0, -1)]) {
      if (part !== undefined) folder = path.join(folder, part)
      const found = await lstat(folder).catch(() => undefined)
      if (found && !found.isDirectory()) {
        throw new RequestError(
          400,
          `${path.relative(libraryDir, folder) || 'The Library folder'} isn’t a plain folder, so Ted won’t save into it.`,
        )
      }
    }
    const file = path.join(folder, parts.at(-1) ?? '')
    const target = await lstat(file).catch(() => undefined)
    if (target && !target.isFile()) {
      throw new RequestError(400, `${name} isn’t a plain file, so Ted won’t replace it.`)
    }
    return file
  }

  async function write(files: Record<string, string | null>): Promise<void> {
    const targets = new Map<string, string>()
    for (const name of Object.keys(files)) targets.set(name, await plainTarget(name))
    for (const [name, text] of Object.entries(files)) {
      const file = targets.get(name) ?? path.join(libraryDir, ...name.split('/'))
      if (text === null) {
        await rm(file, { force: true })
        continue
      }
      await mkdir(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
      await writeFile(tmp, text, { flag: 'wx' })
      await rename(tmp, file).catch(async (error: unknown) => {
        await rm(tmp, { force: true })
        throw error
      })
    }
  }

  return {
    view,

    async preview(changes) {
      const base = await load()
      const { problems, files } = edited(base, changes)
      return {
        files: Object.entries(files).map(([name, text]) => {
          const before = base.current[name]
          return fileChange(name, typeof before === 'string' ? before : '', text ?? '')
        }),
        problems,
        valid: problems.length === 0 && Object.keys(files).length > 0,
      }
    },

    async save({ changes, version }) {
      if (saving) throw new RequestError(409, 'Ted is already saving the Library.')
      saving = true
      try {
        const base = await load()
        if (base.version !== version) {
          throw new RequestError(
            409,
            'The Library changed on disk after this page loaded. Discard your changes to see them, then edit again.',
          )
        }
        const { problems, files } = edited(base, changes)
        const first = problems[0]
        if (first) {
          const at = first.line > 0 ? ` (line ${first.line})` : ''
          throw new RequestError(400, `${first.file}: ${first.message}${at}`)
        }
        if (Object.keys(files).length === 0) throw new RequestError(400, 'There’s nothing to save.')
        await write(files)
      } finally {
        saving = false
      }
      const saved = await view()
      options.saved?.(saved.version)
      options.emit({ type: 'library-changed', version: saved.version })
      return saved
    },
  }
}

function fileOrder(a: string, b: string): number {
  const rank = (name: string) => (name === 'workflow.yaml' ? 0 : name === 'agents.yaml' ? 1 : 2)
  return rank(a) - rank(b) || a.localeCompare(b)
}

function choiceInput(choice: {
  agent?: string
  model?: string
  effort?: string
}): AgentChoiceInput {
  return {
    ...(choice.agent !== undefined && { agent: choice.agent }),
    ...(choice.model !== undefined && { model: choice.model }),
    ...(choice.effort !== undefined && { effort: choice.effort as Effort }),
  }
}
