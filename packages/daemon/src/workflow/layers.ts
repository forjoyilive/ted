import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as git from '../git.ts'
import { type CheckedLayer, checkLayer, type LayerFiles } from './check.ts'

export const defaultsDir = fileURLToPath(new URL('./defaults/', import.meta.url))

export async function readDefaultLayer(): Promise<CheckedLayer> {
  return checkLayer({ kind: 'ted', files: (await readLayerDirectory(defaultsDir)) ?? {} })
}

export async function readLayerDirectory(dir: string): Promise<LayerFiles | undefined> {
  const top = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
    throw error
  })
  if (!top) return undefined
  const files: LayerFiles = {}
  for (const name of ['workflow.yaml', 'notes.md']) {
    if (top.includes(name)) files[name] = await readOrNull(path.join(dir, name))
  }
  if (top.includes('stages')) {
    const stages = await readdir(path.join(dir, 'stages')).catch(() => [])
    for (const name of stages.sort()) {
      files[`stages/${name}`] = await readOrNull(path.join(dir, 'stages', name))
    }
  }
  return files
}

export async function readGitLayer(
  repo: string,
  ref: string,
): Promise<{ files: LayerFiles; version: string } | undefined> {
  const version = await git.revParse(repo, ref)
  const paths = await git.listFiles(repo, version, '.ted')
  const wanted = paths.filter(
    (p) => p === '.ted/workflow.yaml' || p === '.ted/notes.md' || /^\.ted\/stages\/[^/]+$/.test(p),
  )
  if (paths.length === 0) return undefined
  const files: LayerFiles = {}
  for (const file of wanted) {
    files[file.slice('.ted/'.length)] = await git.showFile(repo, version, file).catch(() => null)
  }
  return { files, version: version.slice(0, 7) }
}

export function contentVersion(files: LayerFiles): string {
  const hash = createHash('sha256')
  for (const [name, text] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(`${name}\0${text ?? '\0unreadable'}\0`)
  }
  return hash.digest('hex').slice(0, 7)
}

async function readOrNull(file: string): Promise<string | null> {
  return readFile(file, 'utf8').catch(() => null)
}
