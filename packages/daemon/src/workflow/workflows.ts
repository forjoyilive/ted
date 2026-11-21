import type { DriftCounts, LayerKind, LayerUse } from '@ted/protocol'
import { stageWith } from '@ted/protocol/stage'
import type { Banners } from '../banners.ts'
import type { Clock } from '../clock.ts'
import { clonePath } from '../factories.ts'
import { exists } from '../files.ts'
import * as git from '../git.ts'
import { factoryPermissions, reportRepoPermissions } from '../permissions.ts'
import type { StoredFactory, TedStore } from '../store/index.ts'
import {
  type CheckedLayer,
  checkLayer,
  type InheritedStages,
  inheritedFrom,
  type LayerFiles,
  type WorkflowSettings,
} from './check.ts'
import { driftCount, rememberLayer } from './drift.ts'
import { createFetches } from './fetches.ts'
import {
  contentVersion,
  copyLayer,
  readGitLayerAt,
  readLayerDirectory,
  sameFiles,
  sharedDefaultLayer,
} from './layers.ts'
import { boardStages, type ResolvedWorkflow, resolveWorkflow } from './resolve.ts'

export interface WorkflowResolution {
  workflow: ResolvedWorkflow
  layers: LayerUse[]
}

export interface FactorySource {
  commit: string
  files: LayerFiles
  inherited: CheckedLayer[]
}

export interface Workflows {
  resolve(factory: StoredFactory, options?: { fetch?: boolean }): Promise<WorkflowResolution>
  source(
    factory: StoredFactory,
    options?: { fetch?: boolean; resolve?: boolean },
  ): Promise<FactorySource>
  refresh(factory: StoredFactory, seen: string): Promise<boolean>
  inherited(): Promise<CheckedLayer[]>
  drift(): DriftCounts
  forget(factoryId: string): void
  close(): void
}

export const invalidSettingsProblem = 'workflow-invalid'

export function createWorkflows(options: {
  store: TedStore
  banners: Banners
  libraryDir: string
  reposDir: string
  tedVersion?: string
  onDrift?: (drift: DriftCounts) => void
  onStages?: (factoryId: string) => void
  onFactorySettings?: (
    factory: StoredFactory,
    settings: WorkflowSettings | undefined,
  ) => Promise<void>
  fetch?: (clone: string) => Promise<void>
  now?: () => number
  timeout?: Clock['timeout']
}): Workflows {
  const { store, banners, libraryDir, reposDir } = options
  const fetches = createFetches({
    fetch: options.fetch ?? git.fetch,
    ...(options.now && { now: options.now }),
    ...(options.timeout && { timeout: options.timeout }),
  })
  let closed = false
  const factoryLayers = new Map<string, CheckedLayer | undefined>()
  const factoryFiles = new Map<
    string,
    { commit: string; read: ReturnType<typeof readGitLayerAt> }
  >()
  const factoryRefs = new Map<string, { key: string; read: Promise<string | undefined> }>()
  const counts = new Map<string, number>()
  const checkedLayers = new Map<
    string,
    {
      files: LayerFiles
      primaryRepo: string | undefined
      inherited: string
      layer: CheckedLayer
    }
  >()
  const accepted = new Map<string, string>()
  const remembered = new WeakSet<CheckedLayer>()
  let libraryRead: { files: LayerFiles; version: string } | undefined
  let counted: { defaults: CheckedLayer; library: CheckedLayer | undefined } | undefined
  let layersChanged = true
  let libraryCount = 0
  const stageLists = new Map<string, string>()

  function noteStages(factoryId: string, workflow: ResolvedWorkflow): void {
    const list = JSON.stringify(boardStages(workflow))
    const before = stageLists.get(factoryId)
    if (before === list) return
    stageLists.set(factoryId, list)
    if (before !== undefined) options.onStages?.(factoryId)
  }

  function remember(layers: readonly CheckedLayer[]): void {
    for (const layer of layers) {
      if (remembered.has(layer)) continue
      rememberLayer(layer, options.tedVersion ?? '', (seen) => store.rememberStageFileText(seen))
      remembered.add(layer)
    }
  }

  function checked(
    slot: string,
    kind: LayerKind,
    files: LayerFiles,
    primaryRepo: string | undefined,
    inherited: InheritedStages | undefined,
  ): CheckedLayer {
    const hit = checkedLayers.get(slot)
    const below = JSON.stringify(inherited ?? null)
    if (
      hit &&
      hit.primaryRepo === primaryRepo &&
      hit.inherited === below &&
      sameFiles(hit.files, files)
    ) {
      return hit.layer
    }
    const layer = checkLayer({
      kind,
      files,
      ...(primaryRepo !== undefined && { primaryRepo }),
      ...(inherited && { inherited }),
    })
    checkedLayers.set(slot, { files, primaryRepo, inherited: below, layer })
    return layer
  }

  function setFactoryLayer(id: string, layer: CheckedLayer | undefined): void {
    if (factoryLayers.has(id) && factoryLayers.get(id) === layer) return
    factoryLayers.set(id, layer)
    layersChanged = true
  }

  function drift(): DriftCounts {
    const ids = new Set(store.listFactories().map((f) => f.id))
    return {
      factories: Object.fromEntries([...counts].filter(([id]) => ids.has(id))),
      library: libraryCount,
    }
  }

  function countDrift(defaults: CheckedLayer, library: CheckedLayer | undefined): void {
    if (!layersChanged && counted?.defaults === defaults && counted.library === library) return
    counted = { defaults, library }
    layersChanged = false
    const before = JSON.stringify(drift())
    const inherited = [defaults, ...(library ? [library] : [])]
    libraryCount = library ? driftCount([defaults], library) : 0
    for (const [id, layer] of factoryLayers) {
      counts.set(id, layer ? driftCount(inherited, layer) : 0)
    }
    const after = drift()
    if (JSON.stringify(after) !== before) options.onDrift?.(after)
  }

  function reportChecks(factory: StoredFactory, workflow: ResolvedWorkflow): void {
    const ref = { problem: 'no-checks', factoryId: factory.id }
    const checks = workflow.settings.stages.validate?.checks ?? []
    if (!workflow.stages.includes(stageWith('validates')) || checks.length > 0) {
      banners.clear(ref)
      return
    }
    banners.raise({
      ...ref,
      severity: 'warning',
      text: 'No checks set up · Validate relies on the agent alone',
      action: {
        label: 'Open Configuration',
        opens: { kind: 'factory-settings', factoryId: factory.id },
      },
    })
  }

  function choose(
    kind: LayerKind,
    key: string,
    found: { files: LayerFiles; version: string } | undefined,
    primaryRepo?: string,
    inherited?: InheritedStages,
  ): { layer?: CheckedLayer; use: LayerUse } {
    if (!found) return { use: { layer: kind, status: 'absent', problems: [] } }
    const current = checked(key, kind, found.files, primaryRepo, inherited)
    if (current.valid) {
      if (accepted.get(key) !== found.version) {
        const last = store.lastValidWorkflowLayer(key)
        if (last?.version !== found.version && !(last && sameFiles(last.files, found.files))) {
          store.acceptWorkflowLayer(key, found)
        }
        accepted.set(key, found.version)
      }
      return {
        layer: current,
        use: { layer: kind, status: 'valid', version: found.version, problems: current.problems },
      }
    }
    const last = store.lastValidWorkflowLayer(key)
    if (!last) return { use: { layer: kind, status: 'skipped', problems: current.problems } }
    return {
      layer: checked(`${key}\0last`, kind, last.files, primaryRepo, inherited),
      use: { layer: kind, status: 'last-valid', version: last.version, problems: current.problems },
    }
  }

  function reportInvalid(factory: StoredFactory, use: LayerUse): void {
    const ref = { problem: invalidSettingsProblem, factoryId: factory.id }
    const error = use.problems.find((p) => p.severity === 'error')
    if ((use.status !== 'last-valid' && use.status !== 'skipped') || !error) {
      banners.clear(ref)
      return
    }
    const using =
      use.status === 'last-valid'
        ? `using the last valid version (${use.version ?? ''})`
        : 'using the inherited settings'
    banners.raise({
      ...ref,
      severity: 'warning',
      text: `${error.file} has an error on line ${error.line} · ${using}`,
      action: {
        label: 'Open Configuration',
        opens: { kind: 'factory-settings', factoryId: factory.id },
      },
    })
  }

  async function libraryLayer() {
    const files = await readLayerDirectory(libraryDir)
    if (!files) return choose('library', 'library', undefined)
    if (!libraryRead || !sameFiles(libraryRead.files, files)) {
      libraryRead = { files, version: contentVersion(files) }
    }
    return choose('library', 'library', libraryRead)
  }

  async function factoryFilesAt(factory: StoredFactory, clone: string) {
    const ref = `origin/${factory.defaultBranch}`
    const key = `${clone}\0${ref}`
    let pending = factoryRefs.get(factory.id)
    if (!pending || pending.key !== key) {
      const read = git.revParse(clone, ref).catch(async (error: unknown) => {
        if (await git.hasCommits(clone)) throw error
        return undefined
      })
      pending = { key, read }
      const forget = () => {
        if (factoryRefs.get(factory.id)?.read === read) factoryRefs.delete(factory.id)
      }
      void read.then(forget, forget)
      if (store.getFactory(factory.id)) factoryRefs.set(factory.id, pending)
    }
    const commit = await pending.read
    if (!commit) return undefined
    let cached = factoryFiles.get(factory.id)
    if (!cached || cached.commit !== commit) {
      const read = readGitLayerAt(clone, commit)
      cached = { commit, read }
      const forget = () => {
        if (factoryFiles.get(factory.id)?.read === read) factoryFiles.delete(factory.id)
      }
      void read.then((layer) => {
        if (layer && Object.values(layer.files).some((text) => text === null)) forget()
      }, forget)
      if (store.getFactory(factory.id)) factoryFiles.set(factory.id, cached)
    }
    return { commit, layer: await cached.read }
  }

  type Read = Awaited<ReturnType<typeof read>>

  async function read(factory: StoredFactory, fetch: boolean) {
    const clone = clonePath(reposDir, factory)
    if (fetch) {
      await fetches.fresh(clone).catch((error: unknown) => {
        console.error(`couldn’t fetch ${factory.repo}; using the last fetched .ted/:`, error)
      })
      factoryRefs.delete(factory.id)
    }
    const defaults = await sharedDefaultLayer()
    const library = await libraryLayer()
    const at = (await exists(clone)) ? await factoryFilesAt(factory, clone) : undefined
    return { clone, defaults, library, at }
  }

  function inheritedOf({ defaults, library }: Pick<Read, 'defaults' | 'library'>): CheckedLayer[] {
    const layers = [defaults, ...(library.layer ? [library.layer] : [])]
    remember(layers)
    countDrift(defaults, library.layer)
    return layers.map(copyLayer)
  }

  async function apply(factory: StoredFactory, found: Read): Promise<WorkflowResolution> {
    const { defaults, library } = found
    const factoryLayer = choose(
      'factory',
      `factory:${factory.id}`,
      found.at?.layer,
      factory.repo,
      inheritedFrom([defaults, ...(library.layer ? [library.layer] : [])]),
    )
    remember([defaults, ...(library.layer ? [library.layer] : [])])
    setFactoryLayer(factory.id, factoryLayer.layer)
    countDrift(defaults, library.layer)
    await options.onFactorySettings?.(
      factory,
      factoryLayer.layer && structuredClone(factoryLayer.layer.settings),
    )
    const chosen = [library, factoryLayer]
    const workflow = resolveWorkflow([
      copyLayer(defaults),
      ...chosen.flatMap(({ layer }) => (layer ? [copyLayer(layer)] : [])),
    ])
    reportRepoPermissions(store, banners, factory.id, workflow.settings.permissions)
    workflow.settings.permissions = factoryPermissions(store, factory.id)
    reportChecks(factory, workflow)
    reportInvalid(factory, factoryLayer.use)
    noteStages(factory.id, workflow)
    return {
      workflow,
      layers: [
        { layer: 'ted', status: 'valid', problems: [] },
        ...chosen.map(({ use }) => ({ ...use, problems: use.problems.map((p) => ({ ...p })) })),
      ],
    }
  }

  async function resolve(
    factory: StoredFactory,
    { fetch = true }: { fetch?: boolean } = {},
  ): Promise<WorkflowResolution> {
    return apply(factory, await read(factory, fetch))
  }

  return {
    async inherited() {
      return inheritedOf({ defaults: await sharedDefaultLayer(), library: await libraryLayer() })
    },
    drift,
    forget(factoryId) {
      factoryRefs.delete(factoryId)
      factoryFiles.delete(factoryId)
      factoryLayers.delete(factoryId)
      counts.delete(factoryId)
      accepted.delete(`factory:${factoryId}`)
      checkedLayers.delete(`factory:${factoryId}`)
      checkedLayers.delete(`factory:${factoryId}\0last`)
      stageLists.delete(factoryId)
    },
    resolve,
    async source(factory, { fetch = false, resolve: full = true } = {}) {
      const found = await read(factory, fetch)
      if (full) {
        await apply(factory, found).catch((error: unknown) => {
          console.error(`couldn’t read ${factory.repo}’s Workflow:`, error)
        })
      }
      const inherited = inheritedOf(found)
      if (found.at) {
        return { commit: found.at.commit, files: found.at.layer?.files ?? {}, inherited }
      }
      const commit = await git.revParse(found.clone, `origin/${factory.defaultBranch}`)
      return { commit, files: (await readGitLayerAt(found.clone, commit))?.files ?? {}, inherited }
    },
    async refresh(factory, seen) {
      const clone = clonePath(reposDir, factory)
      await fetches.soon(clone)
      if (closed) return false
      const current = store.getFactory(factory.id)
      if (!current) return false
      const at = (await exists(clone)) ? await factoryFilesAt(current, clone) : undefined
      if (!at || at.commit === seen) return false
      await resolve(current, { fetch: false })
      return true
    },
    close() {
      closed = true
      fetches.close()
    },
  }
}
