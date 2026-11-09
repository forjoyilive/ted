import { stat } from 'node:fs/promises'
import type { LayerKind, LayerUse } from '@ted/protocol'
import type { Banners } from '../banners.ts'
import { clonePath } from '../factories.ts'
import * as git from '../git.ts'
import type { StoredFactory, TedStore } from '../store/index.ts'
import { type CheckedLayer, checkLayer, type LayerFiles, type WorkflowSettings } from './check.ts'
import { contentVersion, readDefaultLayer, readGitLayer, readLayerDirectory } from './layers.ts'
import { type ResolvedWorkflow, resolveWorkflow } from './resolve.ts'

export interface WorkflowResolution {
  workflow: ResolvedWorkflow
  layers: LayerUse[]
}

export interface Workflows {
  resolve(factory: StoredFactory, options?: { fetch?: boolean }): Promise<WorkflowResolution>
}

export function createWorkflows(options: {
  store: TedStore
  banners: Banners
  libraryDir: string
  reposDir: string
  onFactorySettings?: (
    factory: StoredFactory,
    settings: WorkflowSettings | undefined,
  ) => Promise<void>
}): Workflows {
  const { store, banners, libraryDir, reposDir } = options

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

  return {
    async resolve(factory, { fetch = true } = {}) {
      const clone = clonePath(reposDir, factory)
      if (fetch) {
        await git.fetch(clone).catch((error: unknown) => {
          console.error(`couldn’t fetch ${factory.repo}; using the last fetched .ted/:`, error)
        })
      }
      const defaults = await readDefaultLayer()
      const libraryFiles = await readLayerDirectory(libraryDir)
      const library = choose(
        'library',
        'library',
        libraryFiles && { files: libraryFiles, version: contentVersion(libraryFiles) },
      )
      const factoryLayer = choose(
        'factory',
        `factory:${factory.id}`,
        (await exists(clone))
          ? await readGitLayer(clone, `origin/${factory.defaultBranch}`)
          : undefined,
        factory.repo,
      )
      await options.onFactorySettings?.(factory, factoryLayer.layer?.settings)
      const chosen = [library, factoryLayer]
      const workflow = resolveWorkflow([
        defaults,
        ...chosen.flatMap(({ layer }) => (layer ? [layer] : [])),
      ])
      reportChecks(factory, workflow)
      return {
        workflow,
        layers: [{ layer: 'ted', status: 'valid', problems: [] }, ...chosen.map(({ use }) => use)],
      }
    },
  }
}

function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  )
}
