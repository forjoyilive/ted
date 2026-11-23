import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import path from 'node:path'
import { thirdPartyLicenses, thirdPartyPackages } from '../src/third-party.ts'

export const appDir = path.resolve(import.meta.dirname, '..')
export const repoRoot = path.resolve(appDir, '../..')
export const stageDir = path.join(appDir, 'dist', 'stage')

const workspacePackages = ['app', 'daemon', 'protocol', 'cli']

// The stand-ins the sample data runs on (`sampleFixtures` in packages/protocol/src/sample.ts,
// `prepareDemoBinaries` in packages/daemon/src/dev/fixtures.ts, the demo’s stub Linear), and
// the files they import. No other test file ships.
export const sampleFixtures = [
  'free-bytes.txt',
  'load.txt',
  'memory.json',
  'online.txt',
  'stub-claude.ts',
  'stub-codex.ts',
  'stub-gh.ts',
  'stub-idb.ts',
  'stub-json.ts',
  'stub-keyring.ts',
  'stub-linear.ts',
  'stub-shell.sh',
  'stub-xcrun.ts',
]

interface WorkspaceManifest {
  name: string
  exports?: Record<string, string>
}

export async function stage(): Promise<string> {
  await rm(stageDir, { recursive: true, force: true })
  await mkdir(stageDir, { recursive: true })

  const entries = new Map<string, string>()
  for (const name of workspacePackages) {
    const manifest = JSON.parse(
      await readFile(path.join(repoRoot, 'packages', name, 'package.json'), 'utf8'),
    ) as WorkspaceManifest
    for (const [sub, target] of Object.entries(manifest.exports ?? {})) {
      const specifier = sub === '.' ? manifest.name : `${manifest.name}/${sub.slice(2)}`
      entries.set(specifier, path.join('packages', name, target.replace(/\.ts$/, '.js')))
    }
  }

  for (const name of workspacePackages) {
    await copySource(
      path.join(repoRoot, 'packages', name, 'src'),
      path.join(stageDir, 'packages', name, 'src'),
      entries,
    )
  }
  const fixtures = path.join('packages', 'daemon', 'test', 'fixtures')
  await mkdir(path.join(stageDir, fixtures), { recursive: true })
  for (const name of sampleFixtures) {
    await copyFile(path.join(repoRoot, fixtures, name), path.join(stageDir, fixtures), entries)
  }
  await markRelease(stageDir)
  await cp(
    path.join(appDir, 'dist', 'renderer'),
    path.join(stageDir, 'packages', 'app', 'dist', 'renderer'),
    { recursive: true },
  )

  const { placements } = await thirdPartyPackages(repoRoot)
  for (const { dir, at } of placements) {
    await cp(dir, path.join(stageDir, at), { recursive: true, dereference: true })
  }

  const root = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
    version: string
  }
  const topLevel = placements.filter((p) => p.at.split('node_modules').length === 2)
  const dependencies: Record<string, string> = {}
  for (const { dir, at } of topLevel) {
    const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as {
      version: string
    }
    dependencies[at.slice('node_modules/'.length)] = manifest.version
  }
  await writeFile(
    path.join(stageDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'ted',
        productName: 'Ted',
        version: root.version,
        description: 'Runs software factories: agents carry development tasks through a workflow.',
        author: 'Kriya Design LLC',
        license: 'Apache-2.0',
        type: 'module',
        main: 'packages/app/src/entry.js',
        dependencies,
      },
      null,
      2,
    )}\n`,
  )
  for (const file of ['LICENSE', 'NOTICE']) {
    await cp(path.join(repoRoot, file), path.join(stageDir, file))
  }
  await writeFile(
    path.join(stageDir, 'THIRD_PARTY_LICENSES.txt'),
    await thirdPartyLicenses(repoRoot),
  )
  return stageDir
}

export async function markRelease(dir: string): Promise<void> {
  const file = path.join(dir, 'packages', 'protocol', 'src', 'edition.js')
  const code = await readFile(file, 'utf8')
  const devLine = /^export const edition = 'dev'/m
  if (!devLine.test(code)) throw new Error(`No dev edition line to replace in ${file}`)
  await writeFile(file, code.replace(devLine, "export const edition = 'release'"))
}

async function copySource(from: string, to: string, entries: Map<string, string>): Promise<void> {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name)
    if (entry.isDirectory()) {
      await copySource(source, path.join(to, entry.name), entries)
      continue
    }
    if (/\.(tsx|css|d\.ts)$/.test(entry.name)) continue
    await copyFile(source, to, entries)
  }
}

async function copyFile(source: string, to: string, entries: Map<string, string>): Promise<void> {
  const name = path.basename(source)
  if (name.endsWith('.ts')) {
    const target = path.join(to, name.replace(/\.ts$/, '.js'))
    const code = stripTypeScriptTypes(await readFile(source, 'utf8'), { mode: 'strip' })
    await writeFile(target, rewriteSpecifiers(code, target, entries))
  } else {
    await cp(source, path.join(to, name))
  }
}

export function rewriteSpecifiers(
  code: string,
  file: string,
  entries: Map<string, string>,
): string {
  return code
    .replace(/(['"])(\.{1,2}\/[^'"\n]*?)\.ts\1/g, '$1$2.js$1')
    .replace(
      /(['"])(@ted\/[a-z-]+(?:\/[a-z-]+)?)\1/g,
      (match, quote: string, specifier: string) => {
        const target = entries.get(specifier)
        if (target === undefined) return match
        let relative = path.relative(path.dirname(file), path.join(stageDir, target))
        if (!relative.startsWith('.')) relative = `./${relative}`
        return `${quote}${relative.split(path.sep).join('/')}${quote}`
      },
    )
}

if (import.meta.main) {
  console.log(`Staged Ted in ${await stage()}`)
}
