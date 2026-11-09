import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

export interface ThirdPartyPackage {
  name: string
  version: string
  license: string
  dir: string
  runtime: boolean
}

export interface Placement {
  dir: string
  at: string
}

interface Manifest {
  name: string
  version: string
  license?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const workspacePackages = ['app', 'daemon', 'protocol', 'cli']
const windowOnly = new Set([
  'react',
  'react-dom',
  '@fontsource-variable/geist',
  '@fontsource-variable/geist-mono',
])
const notShipped = new Set([
  'electron',
  '@effect/vitest',
  '@effect/platform-browser',
  '@effect/platform-bun',
])
const licenseFile = /^(licen[cs]e|copying|notice)(\.|$)/i

async function readManifest(dir: string): Promise<Manifest> {
  return JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as Manifest
}

async function findPackage(name: string, from: string): Promise<string | undefined> {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name)
    const found = await stat(path.join(candidate, 'package.json')).catch(() => undefined)
    if (found) return realpath(candidate)
    if (path.dirname(dir) === dir) return undefined
  }
}

const dependencyNames = (manifest: Manifest) =>
  [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ].filter(
    (name) => !name.startsWith('@ted/') && !name.startsWith('@types/') && !notShipped.has(name),
  )

export async function thirdPartyPackages(
  repoRoot: string,
): Promise<{ packages: ThirdPartyPackage[]; placements: Placement[] }> {
  const packages = new Map<string, ThirdPartyPackage>()
  const placements: Placement[] = []
  const topLevel = new Map<string, string>()
  const placed = new Set<string>()
  const walkedForWindow = new Set<string>()
  const queue: { name: string; from: string; under: string; runtime: boolean }[] = []

  for (const workspace of workspacePackages) {
    const dir = path.join(repoRoot, 'packages', workspace)
    for (const name of dependencyNames(await readManifest(dir))) {
      queue.push({ name, from: dir, under: '', runtime: !windowOnly.has(name) })
    }
  }
  queue.sort((a, b) => Number(b.runtime) - Number(a.runtime))

  while (queue.length > 0) {
    const next = queue.shift()
    if (!next) break
    const dir = await findPackage(next.name, next.from)
    if (!dir) continue
    const manifest = await readManifest(dir)
    const seen = packages.get(dir)
    if (seen) seen.runtime ||= next.runtime
    else packages.set(dir, { ...(await packageOf(next.name, dir)), runtime: next.runtime })

    let under = ''
    if (next.runtime) {
      const top = topLevel.get(next.name)
      if (top === undefined) topLevel.set(next.name, dir)
      const at =
        top === undefined || top === dir
          ? path.posix.join('node_modules', next.name)
          : path.posix.join(next.under, 'node_modules', next.name)
      if (placed.has(at)) continue
      placed.add(at)
      placements.push({ dir, at })
      under = at
    } else {
      if (seen || walkedForWindow.has(dir)) continue
      walkedForWindow.add(dir)
    }
    for (const name of dependencyNames(manifest)) {
      queue.push({ name, from: dir, under, runtime: next.runtime })
    }
  }

  const sorted = [...packages.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  )
  return { packages: sorted, placements }
}

async function licenseTexts(dir: string): Promise<string[]> {
  const files = (await readdir(dir)).filter((file) => licenseFile.test(file)).sort()
  return Promise.all(
    files.map(async (file) => (await readFile(path.join(dir, file), 'utf8')).trim()),
  )
}

export async function thirdPartyLicenses(repoRoot: string): Promise<string> {
  const appDir = path.join(repoRoot, 'packages', 'app')
  const orchestrator = path.join(appDir, 'third-party', 'agent-orchestrator')
  const sections = [
    [
      (await readFile(path.join(orchestrator, 'NOTICE'), 'utf8')).trim(),
      (await readFile(path.join(orchestrator, 'LICENSE'), 'utf8')).trim(),
    ].join('\n\n'),
  ]
  const electron = await findPackage('electron', appDir)
  const { packages } = await thirdPartyPackages(repoRoot)
  const listed = electron
    ? [{ ...(await packageOf('electron', electron)), runtime: true }, ...packages]
    : packages
  for (const item of listed) {
    const heading = `${item.name} ${item.version} · ${item.license}`
    const texts = await licenseTexts(item.dir)
    const extra =
      item.name === 'electron'
        ? [
            'Electron includes Chromium and Node.js. Their licenses are in LICENSES.chromium.html, which ships with TED.',
          ]
        : []
    sections.push([heading, ...extra, ...texts].join('\n\n'))
  }
  return `${sections.join(`\n\n${'─'.repeat(72)}\n\n`)}\n`
}

async function packageOf(name: string, dir: string): Promise<ThirdPartyPackage> {
  const manifest = await readManifest(dir)
  return {
    name,
    version: manifest.version,
    license: manifest.license ?? 'see license text',
    dir,
    runtime: true,
  }
}
