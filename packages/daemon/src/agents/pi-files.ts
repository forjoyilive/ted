import path from 'node:path'
import { tedPaths } from '@ted/protocol'

const fileName = '([0-9a-f]{64})((?:\\.[a-z0-9]{1,10})?)'

export interface PiFilesOwner {
  runId: string
  taskDisplayId?: string
}

export function piFilesFolder(home: string, owner: PiFilesOwner): string {
  const paths = tedPaths(home)
  return owner.taskDisplayId === undefined
    ? path.join(paths.runs, owner.runId, 'files')
    : path.join(paths.sandbox, owner.taskDisplayId, 'files')
}

export function attachmentFilesIn(home: string, text: string): { hash: string; name: string }[] {
  return [...text.matchAll(attachmentPattern(home))].map(([, hash = '', ext = '']) => ({
    hash,
    name: `${hash}${ext}`,
  }))
}

export function toPiFiles(
  home: string,
  folder: string,
  text: string,
  copied: ReadonlySet<string>,
): string {
  return text.replace(attachmentPattern(home), (found, hash: string, ext: string) =>
    copied.has(`${hash}${ext}`) ? path.join(folder, `${hash}${ext}`) : found,
  )
}

export function fromPiFiles(home: string, text: string): string {
  const paths = tedPaths(home)
  const folders = [paths.sandbox, paths.runs].map((dir) => `${escaped(dir + path.sep)}[\\w-]+`)
  const pattern = new RegExp(
    `(?:${folders.join('|')})${escaped(`${path.sep}files${path.sep}`)}${fileName}`,
    'g',
  )
  return text.replace(pattern, (_, hash: string, ext: string) =>
    path.join(paths.attachments, `${hash}${ext}`),
  )
}

function attachmentPattern(home: string): RegExp {
  return new RegExp(`${escaped(tedPaths(home).attachments + path.sep)}${fileName}`, 'g')
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
