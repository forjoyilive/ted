import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { releaseRepo } from '../packages/protocol/src/release.ts'
import { checkAndRecord, hasPassed } from './check.ts'

const root = path.resolve(import.meta.dirname, '..')
const manifests = ['package.json', 'packages/app/package.json']
const releaseDir = path.join(root, 'packages/app/dist/release')
const recordFile = path.join(releaseDir, 'ted-release.json')
const repo = `${releaseRepo.owner}/${releaseRepo.repo}`

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

function gitMaybe(...args: string[]): string | undefined {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : undefined
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
const built = path.join(releaseDir, 'mac-arm64/TED.app')

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

const developerId = 'Developer ID Application: '

export function pickSigningIdentity(listing: string): string | undefined {
  return [...listing.matchAll(/"(Developer ID Application: [^"]+)"/g)].map((match) => match[1])[0]
}

function useSigningIdentity(): void {
  if (process.env.CSC_LINK || process.env.CSC_NAME) return
  const chosen = process.env.TED_SIGN_IDENTITY
  if (chosen !== undefined && chosen !== '' && !chosen.startsWith(developerId)) {
    fail(`TED_SIGN_IDENTITY must name a “${developerId}…” certificate, not “${chosen}”`)
  }
  const listing = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
  })
  const name = chosen || pickSigningIdentity(listing)
  if (name === undefined) {
    fail(
      'no Developer ID Application certificate in the keychain. Other Macs only open TED, and ' +
        'the updater only installs it, when it is signed with one. Create it in Xcode → ' +
        'Settings → Accounts → Manage Certificates → +.',
    )
  }
  console.log(`\n== Signing with ${name}`)
  process.env.CSC_NAME = name
}

export type Notary = { kind: 'environment' } | { kind: 'profile'; name: string }

export function notaryCredentials(env: NodeJS.ProcessEnv): Notary {
  if (env.APPLE_KEYCHAIN_PROFILE) return { kind: 'profile', name: env.APPLE_KEYCHAIN_PROFILE }
  if (
    (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) ||
    (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID)
  ) {
    return { kind: 'environment' }
  }
  return { kind: 'profile', name: env.TED_NOTARY_PROFILE || 'ted-notary' }
}

function useNotaryCredentials(): void {
  const notary = notaryCredentials(process.env)
  if (notary.kind === 'environment') return
  const check = spawnSync(
    'xcrun',
    ['notarytool', 'history', '--keychain-profile', notary.name, '--output-format', 'json'],
    { encoding: 'utf8' },
  )
  if (check.status !== 0) {
    fail(
      `Apple notarization can’t use the keychain profile “${notary.name}”. Save it once with:\n` +
        `  xcrun notarytool store-credentials ${notary.name}\n` +
        'or set TED_NOTARY_PROFILE to the name of one you already saved.',
    )
  }
  process.env.APPLE_KEYCHAIN_PROFILE = notary.name
}

export function releaseFiles(names: string[]): string[] {
  return names.filter((name) => /\.(dmg|zip|blockmap)$/.test(name) || name === 'latest-mac.yml')
}

export interface ReleaseRecord {
  version: string
  base: string
  commit: string
  files: Record<string, string>
}

function sha512(file: string): string {
  return createHash('sha512').update(readFileSync(file)).digest('base64')
}

function hashes(names: string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, sha512(path.join(releaseDir, name))]))
}

function writeRecord(record: ReleaseRecord): void {
  mkdirSync(releaseDir, { recursive: true })
  writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`)
}

function readRecord(): ReleaseRecord | undefined {
  if (!existsSync(recordFile)) return undefined
  return JSON.parse(readFileSync(recordFile, 'utf8')) as ReleaseRecord
}

export function changedFiles(record: ReleaseRecord, now: Record<string, string>): string[] {
  const names = new Set([...Object.keys(record.files), ...Object.keys(now)])
  return [...names].filter((name) => record.files[name] !== now[name]).sort()
}

function remoteTagCommit(tag: string): string | undefined {
  const lines = git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`)
  const refs = new Map(
    lines
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => {
        const [hash = '', ref = ''] = line.split('\t')
        return [ref, hash] as const
      }),
  )
  return refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`)
}

export interface PublishFacts {
  record: ReleaseRecord | undefined
  branch: string
  head: string
  localTag: string | undefined
  remoteTag: string | undefined
  originMain: string
  changed: string[]
  visibility: string
}

export function publishRefusal(facts: PublishFacts): string | undefined {
  const { record } = facts
  if (record === undefined) return 'there’s no build to publish; run pnpm release <version> first'
  const tag = `v${record.version}`
  if (Object.keys(record.files).length === 0) {
    return `the build of ${tag} didn’t finish; run pnpm release discard, then build again`
  }
  if (facts.branch !== 'main') return 'switch to main first'
  if (facts.head !== record.commit) {
    return `main isn’t at the commit ${tag} was built from; run pnpm release discard, then build again`
  }
  if (facts.localTag !== record.commit) {
    return `the tag ${tag} isn’t at the commit it was built from; run pnpm release discard, then build again`
  }
  if (facts.changed.length > 0) {
    return `these files changed since the build: ${facts.changed.join(', ')}; build again`
  }
  if (facts.remoteTag !== undefined && facts.remoteTag !== record.commit) {
    return `${tag} is already on GitHub at another commit; release a new version`
  }
  if (facts.remoteTag === undefined && facts.originMain !== record.base) {
    return 'main moved on GitHub since the build; run pnpm release discard, pull, and build again'
  }
  if (facts.visibility !== 'PUBLIC') {
    return `${repo} is private, so the updater and other people can’t read its releases; make it public first`
  }
  return undefined
}

export interface DiscardFacts {
  record: ReleaseRecord | undefined
  head: string
  remoteTag: string | undefined
}

export type DiscardPlan = { refusal: string } | { tag: string; resetTo: string | undefined }

export function discardPlan(facts: DiscardFacts): DiscardPlan {
  const { record } = facts
  if (record === undefined) return { refusal: 'there’s no build to discard' }
  const tag = `v${record.version}`
  if (facts.remoteTag !== undefined) {
    return { refusal: `${tag} is already on GitHub; fix the problem in a new version instead` }
  }
  const resetTo =
    record.commit !== record.base && facts.head === record.commit ? record.base : undefined
  return { tag, resetTo }
}

function publish(): void {
  const record = readRecord()
  step('Fetch', 'git', ['fetch', 'origin', 'main'])
  const tag = record === undefined ? '' : `v${record.version}`
  const present =
    record === undefined || !existsSync(releaseDir) ? [] : releaseFiles(readdirSync(releaseDir))
  const visibility = execFileSync(
    'gh',
    ['repo', 'view', repo, '--json', 'visibility', '--jq', '.visibility'],
    { encoding: 'utf8' },
  ).trim()
  const facts: PublishFacts = {
    record,
    branch: git('branch', '--show-current'),
    head: git('rev-parse', 'HEAD'),
    localTag: record === undefined ? undefined : gitMaybe('rev-parse', `${tag}^{commit}`),
    remoteTag: record === undefined ? undefined : remoteTagCommit(tag),
    originMain: git('rev-parse', 'origin/main'),
    changed: record === undefined ? [] : changedFiles(record, hashes(present)),
    visibility,
  }
  const refusal = publishRefusal(facts)
  if (refusal !== undefined) fail(refusal)
  if (record === undefined) return
  if (facts.remoteTag === undefined)
    step('Push', 'git', ['push', '--atomic', 'origin', 'main', tag])
  const files = Object.keys(record.files).map((name) => path.join(releaseDir, name))
  const exists = spawnSync('gh', ['release', 'view', tag, '--repo', repo], { stdio: 'ignore' })
  if (exists.status === 0) {
    step('Upload', 'gh', ['release', 'upload', tag, ...files, '--repo', repo, '--clobber'])
    step('Publish', 'gh', ['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest'])
  } else {
    step('Publish', 'gh', [
      'release',
      'create',
      tag,
      ...files,
      '--repo',
      repo,
      '--title',
      `TED ${record.version}`,
      '--generate-notes',
      '--verify-tag',
      '--latest',
    ])
  }
  console.log(
    `\nTED ${record.version} is published. Installed copies pick it up at their next check.`,
  )
}

function discard(): void {
  const record = readRecord()
  const plan = discardPlan({
    record,
    head: git('rev-parse', 'HEAD'),
    remoteTag: record === undefined ? undefined : remoteTagCommit(`v${record.version}`),
  })
  if ('refusal' in plan) fail(plan.refusal)
  if (gitMaybe('rev-parse', '--verify', '--quiet', `refs/tags/${plan.tag}`) !== undefined) {
    step('Delete the tag', 'git', ['tag', '-d', plan.tag])
  }
  if (plan.resetTo !== undefined)
    step('Undo the release commit', 'git', ['reset', '--keep', plan.resetTo])
  rmSync(recordFile)
  console.log(`\nDiscarded ${plan.tag}. Fix the problem, then run pnpm release again.`)
}

function verifyBuild(): void {
  step('Check the signature', 'codesign', ['--verify', '--deep', '--strict', '--verbose=2', built])
  step('Check Gatekeeper accepts it', 'spctl', [
    '--assess',
    '--type',
    'execute',
    '--verbose',
    built,
  ])
  step('Check the notarization', 'xcrun', ['stapler', 'validate', built])
}

async function build(version: string): Promise<void> {
  const current = currentVersion()
  if (parseVersion(version) === undefined) fail(`“${version}” isn’t a version like 1.2.3`)
  if (git('branch', '--show-current') !== 'main') fail('switch to main first')
  if (git('status', '--porcelain') !== '') fail('commit or stash your changes first')
  const pending = readRecord()
  if (pending !== undefined && remoteTagCommit(`v${pending.version}`) === undefined) {
    fail(
      `${pending.version} is built but not published; run pnpm release publish or pnpm release discard`,
    )
  }
  step('Fetch', 'git', ['fetch', '--tags', 'origin'])
  const base = git('rev-parse', 'HEAD')
  if (base !== git('rev-parse', 'origin/main')) fail('main isn’t the same as origin/main')
  if (git('tag', '--list', `v${version}`) !== '') fail(`tag v${version} already exists`)
  if (remoteTagCommit(`v${version}`) !== undefined) fail(`tag v${version} is already on GitHub`)
  const firstRelease = git('tag', '--list', 'v*') === ''
  if (!(isNewer(version, current) || (firstRelease && version === current)))
    fail(`${version} isn’t newer than ${current}`)
  useSigningIdentity()
  useNotaryCredentials()

  if (hasPassed(base)) {
    console.log('\n== Checks already passed on this commit; skipping them')
    step('Install', 'pnpm', ['install', '--frozen-lockfile'])
  } else if (!(await checkAndRecord({ all: true }))) {
    fail('checks failed')
  }

  if (version !== current) {
    setVersion(version)
    step('Commit', 'git', ['commit', '-am', `Release ${version}`])
  }
  step('Tag', 'git', ['tag', '-a', `v${version}`, '-m', `TED ${version}`])
  rmSync(releaseDir, { recursive: true, force: true })
  const record: ReleaseRecord = { version, base, commit: git('rev-parse', 'HEAD'), files: {} }
  writeRecord(record)
  step('Build', 'pnpm', ['package', '--mac', '--arm64'])
  verifyBuild()
  step('Smoke test the build', 'pnpm', ['--filter', '@ted/app', 'smoke'])
  const files = releaseFiles(readdirSync(releaseDir))
  if (!files.includes('latest-mac.yml') || !files.some((name) => name.endsWith('.zip'))) {
    fail(`the build made no latest-mac.yml or .zip in ${releaseDir}`)
  }
  writeRecord({ ...record, files: hashes(files) })
  install()
  console.log(`\nTED ${version} is built, tagged on this Mac only and installed in ${installed}.`)
  console.log('Try it. Then run pnpm release publish to send it to everyone,')
  console.log('or pnpm release discard to throw it away and build the same version again.')
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--install')) return install()
  const command = args.find((arg) => !arg.startsWith('--'))
  if (command === 'publish') return publish()
  if (command === 'discard') return discard()
  if (command === undefined) {
    fail(`usage: pnpm release <version> | publish | discard | --install (now ${currentVersion()})`)
  }
  await build(command)
}

if (import.meta.main) await main()
