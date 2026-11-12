import type { TaskFileRef, TaskFiles } from '@ted/protocol'

export type Reference =
  | { kind: 'commit'; id: string }
  | { kind: 'task'; id: string }
  | { kind: 'file'; path: string; line?: number }

export interface Piece {
  text: string
  reference?: Reference
}

const start = String.raw`(?<![\w/.@-])`
const end = String.raw`(?![\w/-]|\.\w)`
const pattern = new RegExp(
  [
    String.raw`(?<url>[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+)`,
    String.raw`(?<task>${start}[A-Z][A-Z0-9]{1,9}-\d{1,6}${end})`,
    `(?<commit>${start}[0-9a-f]{7,40}${end})`,
    String.raw`(?<path>${start}(?:\.{1,2}\/)?[\w@+-][\w@.+-]*(?:\/[\w@.+-]+)*(?::(?<line>\d{1,7})(?!\w))?)`,
  ].join('|'),
  'g',
)

const pathLike = (name: string) =>
  name.includes('/') || (/\.[\w+-]*[A-Za-z][\w+-]*$/.test(name) && !/^(e\.g|i\.e)$/i.test(name))

export function references(text: string): Piece[] {
  const pieces: Piece[] = []
  let plain = ''
  let last = 0
  const add = (reference: Reference, shown: string) => {
    if (plain !== '') pieces.push({ text: plain })
    plain = ''
    pieces.push({ text: shown, reference })
  }
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0
    plain += text.slice(last, at)
    last = at + match[0].length
    const { task, commit, path, line } = match.groups ?? {}
    if (task !== undefined) add({ kind: 'task', id: task }, task)
    else if (commit !== undefined) add({ kind: 'commit', id: commit }, commit)
    else if (path !== undefined) {
      const suffix = line === undefined ? '' : `:${line}`
      const whole = path.slice(0, path.length - suffix.length)
      const name = whole.replace(/\.+$/, '')
      const dots = whole.slice(name.length)
      if (!pathLike(name) || (dots !== '' && suffix !== '')) plain += match[0]
      else {
        const reference: Reference = {
          kind: 'file',
          path: name,
          ...(line !== undefined && { line: Number(line) }),
        }
        add(reference, `${name}${suffix}`)
        plain += dots
      }
    } else plain += match[0]
  }
  plain += text.slice(last)
  if (plain !== '') pieces.push({ text: plain })
  return pieces
}

export function candidateCommits(text: string): string[] {
  return references(text).flatMap((piece) =>
    piece.reference?.kind === 'commit' ? [piece.reference.id] : [],
  )
}

export function fileIndex(files: TaskFiles | undefined): (path: string) => TaskFileRef | undefined {
  const exact = new Map<string, TaskFileRef>()
  const byName = new Map<string, TaskFileRef[]>()
  const many = (files?.repos.length ?? 0) > 1
  for (const repo of files?.repos ?? []) {
    for (const path of repo.paths) {
      const file = { repo: repo.repo, path }
      if (!many) exact.set(path, file)
      exact.set(`${repo.repo}/${path}`, file)
      const name = path.slice(path.lastIndexOf('/') + 1)
      const same = byName.get(name)
      if (same) same.push(file)
      else byName.set(name, [file])
    }
  }
  return (asked) => {
    const path = asked.replace(/^\.\//, '')
    const found = exact.get(path)
    if (found) return found
    if (path.startsWith('../')) return undefined
    const name = path.slice(path.lastIndexOf('/') + 1)
    const matches = (byName.get(name) ?? []).filter(
      (file) => file.path === path || file.path.endsWith(`/${path}`),
    )
    return matches.length === 1 ? matches[0] : undefined
  }
}
