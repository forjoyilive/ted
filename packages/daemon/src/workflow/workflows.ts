import type { DriftCounts, LayerKind, LayerUse } from '@ted/protocol'
import type { Banners } from '../banners.ts'
import { clonePath } from '../factories.ts'
import { exists } from '../files.ts'
import * as git from '../git.ts'
import { factoryPermissions, reportRepoPermissions } from '../permissions.ts'
import type { StoredFactory, TedStore } from '../store/index.ts'
import { type CheckedLayer, checkLayer, type LayerFiles, type WorkflowSettings } from './check.ts'
import { findDrift, rememberLayer } from './drift.ts'
import { contentVersion, readDefaultLayer, readGitLayer, readLayerDirectory } from './layers.ts'
import { type ResolvedWorkflow, resolveWorkflow } from './resolve.ts'

export interface WorkflowResolution {
  workflow: ResolvedWorkflow
  layers: LayerUse[]
}

export interface Workflows {
  resolve(factory: StoredFactory, options?: { fetch?: boolean }): Promise<WorkflowResolution>
  inherited(): Promise<CheckedLayer[]>
  drift(): DriftCounts
}

export const invalidSettingsProblem = 'workflow-invalid'

export function createWorkflows(options: {
  store: TedStore
  banners: Banners
  libraryDir: string
  reposDir: string
  tedVersion?: string
  onDrift?: (drift: DriftCounts) => void
  onFactorySettings?: (
    factory: StoredFactory,
    settings: WorkflowSettings | undefined,
  ) => Promise<void>
}): Workflows {
  const { store, banners, libraryDir, reposDir } = options
  const factoryLayers = new Map<string, CheckedLayer | undefined>()
  const counts = new Map<string, number>()
  let libraryCount = 0

  function remember(layers: readonly CheckedLayer[]): void {
    for (const layer of layers) {
      rememberLayer(layer, options.tedVersion ?? '', (seen) => store.rememberStageFileText(seen))
    }
  }

  function drift(): DriftCounts {
    const ids = new Set(store.listFactories().map((f) => f.id))
    return {
      factories: Object.fromEntries([...counts].filter(([id]) => ids.has(id))),
      library: libraryCount,
    }
  }

  function countDrift(defaults: CheckedLayer, library: CheckedLayer | undefined): void {
    const before = JSON.stringify(drift())
    const inherited = [defaults, ...(library ? [library] : [])]
    libraryCount = library ? findDrift([defaults], library).length : 0
    for (const [id, layer] of factoryLayers) {
      counts.set(id, layer ? findDrift(inherited, layer).length : 0)
    }
    const after = drift()
    if (JSON.stringify(after) !== before) options.onDrift?.(after)
  }

  function reportChecks(factory: StoredFactory, workflow: ResolvedWorkflow): void {
    const ref = { problem: 'no-checks', factoryId: factory.id }
    const checks = workflow.settings.stages.validate?.checks ?? []
    if (!workflow.stages.includes('validate') || checks.length > 0) {
      banners.clear(ref)
      return
    }
    banners.raise({
      ...ref,
      severity: 'warning',
      text: 'No Checks set up · Validate relies on the agent alone',
      action: {
        label: 'Open Factory settings',
        opens: { kind: 'factory-settings', factoryId: factory.id },
      },
    })
  }

  function choose(
    kind: LayerKind,
    key: string,
    found: { files: LayerFiles; version: string } | undefined,
    primaryRepo?: string,
  ): { layer?: CheckedLayer; use: LayerUse } {
    if (!found) return { use: { layer: kind, status: 'absent', problems: [] } }
    const check = (files: LayerFiles) =>
      checkLayer({ kind, files, ...(primaryRepo !== undefined && { primaryRepo }) })
    const current = check(found.files)
    if (current.valid) {
      if (store.lastValidWorkflowLayer(key)?.version !== found.version) {
        store.acceptWorkflowLayer(key, found)
      }
      return {
        layer: current,
        use: { layer: kind, status: 'valid', version: found.version, problems: current.problems },
      }
    }
    const last = store.lastValidWorkflowLayer(key)
    if (!last) return { use: { layer: kind, status: 'skipped', problems: current.problems } }
    return {
      layer: check(last.files),
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
        label: 'Open Factory settings',
        opens: { kind: 'factory-settings', factoryId: factory.id },
      },
    })
  }

  async function libraryLayer() {
    const libraryFiles = await readLayerDirectory(libraryDir)
    return choose(
      'library',
      'library',
      libraryFiles && { files: libraryFiles, version: contentVersion(libraryFiles) },
    )
  }

  return {
    async inherited() {
      const library = await libraryLayer()
      const defaults = await readDefaultLayer()
      const layers = [defaults, ...(library.layer ? [library.layer] : [])]
      remember(layers)
      countDrift(defaults, library.layer)
      return layers
    },
    drift,
    async resolve(factory, { fetch = true } = {}) {
      const clone = clonePath(reposDir, factory)
      if (fetch) {
        await git.fetch(clone).catch((error: unknown) => {
          console.error(`couldn’t fetch ${factory.repo}; using the last fetched .ted/:`, error)
        })
      }
      const defaults = await readDefaultLayer()
      const library = await libraryLayer()
      const factoryLayer = choose(
        'factory',
        `factory:${factory.id}`,
        (await exists(clone))
          ? await readGitLayer(clone, `origin/${factory.defaultBranch}`)
          : undefined,
        factory.repo,
      )
      remember([defaults, ...(library.layer ? [library.layer] : [])])
      factoryLayers.set(factory.id, factoryLayer.layer)
      countDrift(defaults, library.layer)
      await options.onFactorySettings?.(factory, factoryLayer.layer?.settings)
      const chosen = [library, factoryLayer]
      const workflow = resolveWorkflow([
        defaults,
        ...chosen.flatMap(({ layer }) => (layer ? [layer] : [])),
      ])
      reportRepoPermissions(store, banners, factory.id, workflow.settings.permissions)
      workflow.settings.permissions = factoryPermissions(store, factory.id)
      reportChecks(factory, workflow)
      reportInvalid(factory, factoryLayer.use)
      return {
        workflow,
        layers: [{ layer: 'ted', status: 'valid', problems: [] }, ...chosen.map(({ use }) => use)],
      }
    },
  }
}
