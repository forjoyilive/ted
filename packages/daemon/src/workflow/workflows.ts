import type { LayerKind, LayerUse } from '@ted/protocol'
import { clonePath } from '../factories.ts'
import * as git from '../git.ts'
import type { StoredFactory, TedStore } from '../store/index.ts'
import { type CheckedLayer, checkLayer, type LayerFiles } from './check.ts'
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
  libraryDir: string
  reposDir: string
}): Workflows {
  const { store, libraryDir, reposDir } = options

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
        await readGitLayer(clone, `origin/${factory.defaultBranch}`),
        factory.repo,
      )
      const chosen = [library, factoryLayer]
      return {
        workflow: resolveWorkflow([
          defaults,
          ...chosen.flatMap(({ layer }) => (layer ? [layer] : [])),
        ]),
        layers: [{ layer: 'ted', status: 'valid', problems: [] }, ...chosen.map(({ use }) => use)],
      }
    },
  }
}
