import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BuiltInAgentId } from '@ted/protocol/agent-files'
import * as git from '../git.ts'
import { type CheckedLayer, checkLayer, type LayerFiles } from './check.ts'

export const defaultsDir = fileURLToPath(new URL('./defaults/', import.meta.url))

let defaultLayer: Promise<CheckedLayer> | undefined

export function sharedDefaultLayer(): Promise<CheckedLayer> {
  if (!defaultLayer) {
    const read = readLayerDirectory(defaultsDir).then((files) =>
      checkLayer({ kind: 'ted', files: files ?? {} }),
    )
    defaultLayer = read
    read.catch(() => {
      if (defaultLayer === read) defaultLayer = undefined
    })
  }
  return defaultLayer
}

export async function builtInAgentText(id: BuiltInAgentId): Promise<string> {
  const text = (await sharedDefaultLayer()).agentFiles[id]
  if (text === undefined) throw new Error(`TED’s built-in ${id} instructions are missing`)
  return text
}

export async function readDefaultLayer(): Promise<CheckedLayer> {
  return copyLayer(await sharedDefaultLayer())
}

export function copyLayer(layer: CheckedLayer): CheckedLayer {
  return {
    ...layer,
    files: { ...layer.files },
    settings: structuredClone(layer.settings),
    stageFiles: { ...layer.stageFiles },
    agentSettings: structuredClone(layer.agentSettings),
    agentFiles: { ...layer.agentFiles },
    problems: layer.problems.map((problem) => ({ ...problem })),
  }
}

export function sameFiles(a: LayerFiles, b: LayerFiles): boolean {
  if (a === b) return true
  const names = Object.keys(a)
  return (
    names.length === Object.keys(b).length &&
    names.every((name) => name in b && a[name] === b[name])
  )
}

export async function readLayerDirectory(dir: string): Promise<LayerFiles | undefined> {
  const top = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
    throw error
  })
  if (!top) return undefined
  const named = ['workflow.yaml', 'notes.md', 'agents.yaml'].filter((name) => top.includes(name))
  const folders = ['stages', 'agents'] as const
  const listed = await Promise.all(
    folders.map((folder) =>
      top.includes(folder) ? readdir(path.join(dir, folder)).catch(() => null) : undefined,
    ),
  )
  const inFolders = folders.flatMap((folder, i) =>
    (listed[i] ?? []).sort().map((name) => `${folder}/${name}`),
  )
  const names = [...named, ...inFolders]
  const texts = await Promise.all(names.map((name) => readOrNull(path.join(dir, name))))
  const files: LayerFiles = {}
  for (const [i, name] of named.entries()) files[name] = texts[i] ?? null
  for (const [i, folder] of folders.entries()) if (listed[i] === null) files[folder] = null
  for (const [i, name] of inFolders.entries()) files[name] = texts[named.length + i] ?? null
  return files
}

export async function readGitLayer(
  repo: string,
  ref: string,
): Promise<{ files: LayerFiles; version: string } | undefined> {
  if (!(await git.hasCommits(repo))) return undefined
  return readGitLayerAt(repo, await git.revParse(repo, ref))
}

const blobsAtOnce = 8

export async function readGitLayerAt(
  repo: string,
  commit: string,
): Promise<{ files: LayerFiles; version: string } | undefined> {
  const paths = await git.listFiles(repo, commit, '.ted')
  const wanted = paths.filter(
    (p) =>
      p === '.ted/workflow.yaml' ||
      p === '.ted/notes.md' ||
      p === '.ted/agents.yaml' ||
      /^\.ted\/(stages|agents)\/[^/]+$/.test(p),
  )
  if (paths.length === 0) return undefined
  const texts: (string | null)[] = new Array(wanted.length).fill(null)
  let next = 0
  const worker = async () => {
    while (next < wanted.length) {
      const i = next++
      texts[i] = await git.showFile(repo, commit, wanted[i] as string).catch(() => null)
    }
  }
  await Promise.all(Array.from({ length: Math.min(blobsAtOnce, wanted.length) }, worker))
  const files: LayerFiles = {}
  for (const [i, file] of wanted.entries()) files[file.slice('.ted/'.length)] = texts[i] ?? null
  return { files, version: commit.slice(0, 7) }
}

export function stageFileHash(text: string): string {
  return createHash('sha1')
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest('hex')
    .slice(0, 7)
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
