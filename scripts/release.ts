import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { checkAndRecord, hasPassed } from './check.ts'

const root = path.resolve(import.meta.dirname, '..')
const manifests = ['package.json', 'packages/app/package.json']

export function parseVersion(text: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text)
  if (match === null) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function isNewer(next: string, current: string): boolean {
  const a = parseVersion(next)
  const b = parseVersion(current)
  if (a === undefined || b === undefined) return false
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return false
}

function fail(message: string): never {
  console.error(`release: ${message}`)
  process.exit(1)
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function step(title: string, command: string, args: string[]): void {
  console.log(`\n== ${title}`)
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) fail(`${title} failed`)
}

function currentVersion(): string {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    version: string
  }
  return manifest.version
}

function setVersion(version: string): void {
  for (const file of manifests) {
    const full = path.join(root, file)
    const text = readFileSync(full, 'utf8')
    writeFileSync(full, text.replace(/"version": "[^"]+"/, `"version": "${version}"`))
  }
}

const installed = '/Applications/TED.app'
const built = path.join(root, 'packages/app/dist/release/mac-arm64/TED.app')

function running(): boolean {
  return spawnSync('pgrep', ['-f', `${installed}/Contents/MacOS/`]).status === 0
}

function install(): void {
  console.log(`\n== Install into ${installed}`)
  if (!existsSync(built)) fail(`the build isn’t at ${built}`)
  if (running()) fail(`quit TED first (TED menu → Quit), then run: pnpm release --install`)
  rmSync(installed, { recursive: true, force: true })
  step('Copy', 'ditto', [built, installed])
}

export function pickSigningIdentity(listing: string): string | undefined {
  const names = [
    ...listing.matchAll(/"((?:Developer ID Application|Apple Development): [^"]+)"/g),
  ].map((match) => match[1] ?? '')
  return names.find((name) => name.startsWith('Developer ID Application')) ?? names[0]
}

function useSigningIdentity(): void {
  if (process.env.CSC_LINK || process.env.CSC_NAME) return
  const listing = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
  })
  const name = process.env.TED_SIGN_IDENTITY || pickSigningIdentity(listing)
  if (name === undefined) {
    console.log(
      '\nNo code-signing identity found; building unsigned, so macOS will ask again for the keychain.',
    )
    return
  }
  console.log(`\n== Signing with ${name}`)
  process.env.CSC_NAME = name
}

async function main(): Promise<void> {
  if (process.argv.includes('--install')) {
    install()
    return
  }
  const args = process.argv.slice(2)
  const version = args.find((arg) => !arg.startsWith('--'))
  const current = currentVersion()
  if (version === undefined) fail(`usage: pnpm release <version> (now ${current})`)
  if (parseVersion(version) === undefined) fail(`“${version}” isn’t a version like 1.2.3`)

  if (git('branch', '--show-current') !== 'main') fail('switch to main first')
  if (git('status', '--porcelain') !== '') fail('commit or stash your changes first')
  step('Fetch', 'git', ['fetch', '--tags', 'origin'])
  if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main'))
    fail('main isn’t the same as origin/main')
  if (git('tag', '--list', `v${version}`) !== '') fail(`tag v${version} already exists`)
  const firstRelease = git('tag', '--list', 'v*') === ''
  if (!(isNewer(version, current) || (firstRelease && version === current)))
    fail(`${version} isn’t newer than ${current}`)

  if (hasPassed(git('rev-parse', 'HEAD'))) {
    console.log('\n== Checks already passed on this commit; skipping them')
    step('Install', 'pnpm', ['install', '--frozen-lockfile'])
  } else if (!(await checkAndRecord())) {
    fail('checks failed')
  }

  if (version !== current) {
    setVersion(version)
    step('Commit', 'git', ['commit', '-am', `Release ${version}`])
  }
  step('Tag', 'git', ['tag', '-a', `v${version}`, '-m', `TED ${version}`])
  step('Push', 'git', ['push', '--atomic', 'origin', 'main', `v${version}`])
  useSigningIdentity()
  step('Build', 'pnpm', ['package', '--mac', '--arm64', '--dir'])
  step('Smoke test the build', 'pnpm', ['--filter', '@ted/app', 'smoke'])
  install()
  console.log(`\nTED ${version} is tagged, pushed and installed in ${installed}.`)
  console.log(
    'GitHub is running the full test suite on Linux for this tag: gh run list --workflow CI --limit 1',
  )
}

if (import.meta.main) await main()
