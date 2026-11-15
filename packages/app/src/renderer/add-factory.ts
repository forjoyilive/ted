import type { RepoCheck, RepoSource } from '@ted/protocol/factory'
import { repoNamePattern } from '@ted/protocol/factory'
import type { IntegrationFix, IntegrationsHealth } from '@ted/protocol/integrations'
import { plural } from './words.ts'

export interface RepoRow {
  id: string
  source?: RepoSource
  text: string
  name: string
  nameEdited: boolean
  check?: RepoCheck
  checking: boolean
}

export interface GitHubProblem {
  text: string
  fix: IntegrationFix
  label: string
  host?: string
}

export function githubProblem(health: IntegrationsHealth | undefined): GitHubProblem | undefined {
  if (!health) return undefined
  const { cli, hosts } = health.github
  if (cli.state === 'not-installed') {
    return { text: 'GitHub CLI isn’t installed', fix: 'gh-install', label: 'Fix' }
  }
  if (cli.state === 'too-old') {
    return { text: `GitHub CLI ${cli.version ?? ''} is too old`, fix: 'gh-update', label: 'Fix' }
  }
  const host = hosts.find((h) => h.host === 'github.com') ?? hosts[0]
  if (host?.state === 'signed-out') {
    return { text: 'GitHub CLI is signed out', fix: 'gh-login', label: 'Fix', host: host.host }
  }
  return undefined
}

export const isFilled = (row: RepoRow) => row.source !== undefined

export function nameProblem(row: RepoRow, rows: readonly RepoRow[]): string | undefined {
  if (!isFilled(row) || row.check?.name === undefined) return undefined
  if (!repoNamePattern.test(row.name)) return 'Use lowercase letters, digits and -.'
  const same = rows.filter((r) => isFilled(r) && r.check?.name !== undefined && r.name === row.name)
  if (same.length > 1) return 'Another repo has this name.'
  return undefined
}

export function rowLabel(row: RepoRow): string {
  if (row.check?.repo !== undefined) return row.check.repo.split('/').at(-1) ?? row.check.repo
  if (row.source && 'folder' in row.source) {
    return row.source.folder.split(/[\\/]/).filter(Boolean).at(-1) ?? row.source.folder
  }
  return row.text
}

export interface FormState {
  rows: readonly RepoRow[]
  name: string
  keyProblem: string | undefined
  key: string
  github: GitHubProblem | undefined
}

export interface Footer {
  text: string
  blocked: boolean
  problem: boolean
}

const listed = (names: string[]) =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

export function footer({ rows, name, keyProblem, key, github }: FormState): Footer {
  const filled = rows.filter(isFilled)
  if (github) return { text: `${github.text}. Fix it to continue.`, blocked: true, problem: true }
  if (filled.length === 0 || !isFilled(rows[0] as RepoRow)) {
    return {
      text: 'Choose a folder or give a GitHub repo to start.',
      blocked: true,
      problem: false,
    }
  }
  const checking = filled.filter((r) => r.checking || r.check === undefined)
  const problems = filled.filter((r) => !r.checking && r.check !== undefined && !r.check.ok)
  const badNames = filled.filter((r) => nameProblem(r, rows) !== undefined)
  if (checking.length > 0) {
    const waiting = `Waiting for ${plural(checking.length, 'access check')}.`
    if (problems.length === 0) return { text: waiting, blocked: true, problem: false }
    const names = problems.map(rowLabel)
    return {
      text: `${waiting} Fix or remove the ${listed(names)} ${problems.length === 1 ? 'row' : 'rows'}.`,
      blocked: true,
      problem: false,
    }
  }
  const fixes: string[] = []
  if (problems.length > 0) fixes.push(`the ${plural(problems.length, 'repo problem')}`)
  if (badNames.length > 0) fixes.push(`the ${badNames.length === 1 ? 'repo name' : 'repo names'}`)
  if (name.trim() === '') fixes.push('the name')
  if (keyProblem !== undefined) fixes.push('the key')
  if (fixes.length > 0) {
    return { text: `Fix ${listed(fixes)} to continue.`, blocked: true, problem: true }
  }
  const clones =
    filled.length === 1
      ? 'the repo'
      : filled.length === 2
        ? 'both repos'
        : `all ${filled.length} repos`
  const settled = rows[0]?.check?.notes.some((n) => n.startsWith('Has TED settings')) === true
  return {
    text: settled
      ? `TED clones ${clones}. The setup Task ${key}-1 will wait in Backlog.`
      : `TED clones ${clones}, then starts the setup Task ${key}-1.`,
    blocked: false,
    problem: false,
  }
}

export function moveRow<T>(rows: readonly T[], from: number, to: number): T[] {
  if (from === 0 || to === 0 || from === to) return [...rows]
  const next = [...rows]
  const [moved] = next.splice(from, 1)
  if (moved === undefined) return [...rows]
  next.splice(to, 0, moved)
  return next
}

const protectedFolders = [
  { folder: 'Documents', name: 'Documents folder' },
  { folder: 'Desktop', name: 'Desktop folder' },
  { folder: 'Downloads', name: 'Downloads folder' },
  { folder: 'Library/Mobile Documents', name: 'iCloud Drive' },
]

export function protectedFolderNote(
  folder: string,
  home: string | undefined,
  mac: boolean,
): string | undefined {
  if (!mac || !home) return undefined
  const found = protectedFolders.find(({ folder: inHome }) => {
    const root = `${home}/${inHome}`
    return folder === root || folder.startsWith(`${root}/`)
  })
  if (!found) return undefined
  return `macOS may ask whether TED can use your ${found.name}. Allow it: TED reads this folder to check the repo and copies the files you list from it into each Task.`
}

export function shortPath(folder: string, home: string | undefined): string {
  if (home && (folder === home || folder.startsWith(`${home}/`)))
    return `~${folder.slice(home.length)}`
  return folder
}
