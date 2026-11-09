import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

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

function linuxCi(): void {
  console.log('\n== GitHub CI on main (Linux)')
  const before = git('rev-parse', 'HEAD')
  step('Start GitHub CI', 'gh', ['workflow', 'run', 'CI', '--ref', 'main'])
  let id = ''
  for (let tries = 0; tries < 30 && id === ''; tries++) {
    spawnSync('sleep', ['5'])
    id = execFileSync(
      'gh',
      [
        'run',
        'list',
        '--workflow',
        'CI',
        '--branch',
        'main',
        '--event',
        'workflow_dispatch',
        '--commit',
        before,
        '--limit',
        '1',
        '--json',
        'databaseId',
        '--jq',
        '.[0].databaseId // ""',
      ],
      { cwd: root, encoding: 'utf8' },
    ).trim()
  }
  if (id === '') fail('couldn’t find the GitHub CI run it started')
  step('Wait for GitHub CI', 'gh', ['run', 'watch', id, '--exit-status', '--interval', '60'])
}

function main(): void {
  const args = process.argv.slice(2)
  const skipLinux = args.includes('--skip-linux')
  const version = args.find((arg) => !arg.startsWith('--'))
  const current = currentVersion()
  if (version === undefined) fail(`usage: pnpm release <version> [--skip-linux] (now ${current})`)
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

  step('Install', 'pnpm', ['install', '--frozen-lockfile'])
  step('Typecheck', 'pnpm', ['typecheck'])
  step('Lint', 'pnpm', ['lint'])
  step('Test', 'pnpm', ['test'])
  if (!skipLinux) linuxCi()

  if (version !== current) {
    setVersion(version)
    step('Commit', 'git', ['commit', '-am', `Release ${version}`])
  }
  step('Tag', 'git', ['tag', '-a', `v${version}`, '-m', `TED ${version}`])
  step('Push', 'git', ['push', '--atomic', 'origin', 'main', `v${version}`])
  console.log(`\nPushed v${version}. GitHub is building the installers into a draft release:`)
  console.log('  gh run list --workflow "Release builds" --limit 1')
  console.log('Publish the draft on GitHub when it looks right.')
}

if (import.meta.main) main()
