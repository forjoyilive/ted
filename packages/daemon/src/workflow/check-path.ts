import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { LayerKind, WorkflowProblem } from '@ted/protocol'
import * as git from '../git.ts'
import {
  type CheckedLayer,
  checkLayer,
  githubRepoOf,
  inheritedFrom,
  type LayerFiles,
} from './check.ts'
import { readDefaultLayer, readLayerDirectory } from './layers.ts'

export interface PathProblem extends WorkflowProblem {
  path: string
}

export class NothingToCheckError extends Error {}

export async function checkWorkflowPath(
  target: string,
  options: { libraryDir: string },
): Promise<PathProblem[]> {
  const info = await stat(target).catch(() => undefined)
  if (!info) throw new NothingToCheckError(`there’s nothing at ${target}`)

  let layerDir: string
  let files: LayerFiles
  if (info.isDirectory()) {
    const nested = path.join(target, '.ted')
    layerDir = (await stat(nested).catch(() => undefined))?.isDirectory() ? nested : target
    files = (await readLayerDirectory(layerDir)) ?? {}
  } else {
    const name = path.basename(target)
    const inStages = path.basename(path.dirname(target)) === 'stages'
    layerDir = inStages ? path.dirname(path.dirname(target)) : path.dirname(target)
    const key = inStages ? `stages/${name}` : name
    if (key !== 'workflow.yaml' && !key.startsWith('stages/')) {
      throw new NothingToCheckError(`${target} isn’t a workflow.yaml or a Stage file`)
    }
    files = { [key]: await readFile(target, 'utf8').catch(() => null) }
  }

  const kind: LayerKind = (await sameDir(layerDir, options.libraryDir)) ? 'library' : 'factory'
  const primaryRepo = kind === 'factory' ? await originRepo(path.dirname(layerDir)) : undefined
  const below: CheckedLayer[] = [await readDefaultLayer()]
  if (kind === 'factory') {
    const libraryFiles = await readLayerDirectory(options.libraryDir).catch(() => undefined)
    const library = libraryFiles && checkLayer({ kind: 'library', files: libraryFiles })
    if (library?.valid) below.push(library)
  }
  const { problems } = checkLayer({
    kind,
    files,
    inherited: inheritedFrom(below),
    ...(primaryRepo !== undefined && { primaryRepo }),
  })
  return problems.map((problem) => ({
    ...problem,
    path: path.join(
      layerDir,
      kind === 'factory' ? problem.file.replace(/^\.ted\//, '') : problem.file,
    ),
  }))
}

async function sameDir(a: string, b: string): Promise<boolean> {
  const [ra, rb] = await Promise.all([realpath(a).catch(() => a), realpath(b).catch(() => b)])
  return ra === rb
}

async function originRepo(dir: string): Promise<string | undefined> {
  const url = await git.remoteUrl(dir).catch(() => undefined)
  return url === undefined ? undefined : githubRepoOf(url)
}
