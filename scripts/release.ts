import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { releaseRepo } from '../packages/protocol/src/release.ts'
import { checkAndRecord, hasPassed } from './check.ts'

const root = path.resolve(import.meta.dirname, '..')
const manifests = ['package.json', 'packages/app/package.json']
const releaseDir = path.join(root, 'packages/app/dist/release')
const recordFile = path.join(releaseDir, 'ted-release.json')
const notesFile = path.join(releaseDir, 'release-notes.md')
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

const installed = '/Applications/Ted.app'
const built = path.join(releaseDir, 'mac-arm64/Ted.app')

function running(): boolean {
  return spawnSync('pgrep', ['-i', '-f', `${installed}/Contents/MacOS/`]).status === 0
}

function install(): void {
  console.log(`\n== Install into ${installed}`)
  if (!existsSync(built)) fail(`the build isn’t at ${built}`)
  if (running()) fail(`quit Ted first (Ted menu → Quit), then run: pnpm release --install`)
  rmSync(installed, { recursive: true, force: true })
  step('Copy', 'ditto', [built, installed])
}

const developerId = 'Developer ID Application: '

export function pickSigningIdentity(listing: string): string | undefined {
  return [...listing.matchAll(/"(Developer ID Application: [^"]+)"/g)].map((match) => match[1])[0]
}

// electron-builder refuses a CSC_NAME that starts with the certificate type and picks the
// Developer ID Application certificate for the name itself.
export function builderIdentity(name: string): string {
  return name.startsWith(developerId) ? name.slice(developerId.length) : name
}

export function signingRefusal(env: NodeJS.ProcessEnv): string | undefined {
  if (env.CSC_LINK) {
    return 'pnpm release signs from the keychain and can’t check a CSC_LINK certificate; unset CSC_LINK'
  }
  for (const name of ['CSC_NAME', 'TED_SIGN_IDENTITY'] as const) {
    const chosen = env[name]
    if (chosen && !chosen.startsWith(developerId)) {
      return `${name} must name a “${developerId}…” certificate, not “${chosen}”`
    }
  }
  return undefined
}

function useSigningIdentity(): void {
  const refusal = signingRefusal(process.env)
  if (refusal !== undefined) fail(refusal)
  const chosen = process.env.CSC_NAME || process.env.TED_SIGN_IDENTITY
  const listing = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
  })
  const name = chosen || pickSigningIdentity(listing)
  if (name === undefined) {
    fail(
      'no Developer ID Application certificate in the keychain. Other Macs only open Ted, and ' +
        'the updater only installs it, when it is signed with one. Create it in Xcode → ' +
        'Settings → Accounts → Manage Certificates → +.',
    )
  }
  console.log(`\n== Signing with ${name}`)
  process.env.CSC_NAME = builderIdentity(name)
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
  notes: 'missing' | 'ready'
  head: string
  localTag: string | undefined
  remoteTag: string | undefined
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
  if (facts.head !== record.commit) {
    return `the release checkout isn’t at the commit ${tag} was built from; run pnpm release discard, then build again`
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
  if (facts.notes === 'missing') {
    return `there are no release notes at ${notesFile}; run pnpm release discard, then build again`
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
    notes: existsSync(notesFile) ? 'ready' : 'missing',
    head: git('rev-parse', 'HEAD'),
    localTag: record === undefined ? undefined : gitMaybe('rev-parse', `${tag}^{commit}`),
    remoteTag: record === undefined ? undefined : remoteTagCommit(tag),
    changed: record === undefined ? [] : changedFiles(record, hashes(present)),
    visibility,
  }
  const refusal = publishRefusal(facts)
  if (refusal !== undefined) fail(refusal)
  if (record === undefined) return
  if (facts.remoteTag === undefined) step('Push the tag', 'git', ['push', 'origin', tag])
  const files = Object.keys(record.files).map((name) => path.join(releaseDir, name))
  const exists = spawnSync('gh', ['release', 'view', tag, '--repo', repo], { stdio: 'ignore' })
  if (exists.status === 0) {
    step('Upload', 'gh', ['release', 'upload', tag, ...files, '--repo', repo, '--clobber'])
    step('Publish', 'gh', [
      'release',
      'edit',
      tag,
      '--repo',
      repo,
      '--notes-file',
      notesFile,
      '--draft=false',
      '--latest',
    ])
  } else {
    step('Publish', 'gh', [
      'release',
      'create',
      tag,
      ...files,
      '--repo',
      repo,
      '--title',
      `Ted ${record.version}`,
      '--notes-file',
      notesFile,
      '--verify-tag',
      '--latest',
    ])
  }
  mergeBack(record)
  updateWebsite(record)
  console.log(
    `\nTed ${record.version} is published. Installed copies pick it up at their next check.`,
  )
}

export interface Change {
  title: string
  branch?: string
  pullRequest?: number
  files: string[]
}

export type ChangeKind = 'feature' | 'fix' | 'other'

const housekeeping =
  /^(docs\/|scripts\/|\.ted\/|\.github\/|test\/|packages\/[^/]+\/test\/|[^/]+\.md$|vitest\.config\.ts$|biome\.json$)/
const fixWords =
  /^(fix|fixes|stop|stops|don[’']t|wait|refuse|restore|prevent|avoid|correct|repair)\b/i

export function changeKind(change: Change): ChangeKind {
  if (change.files.length > 0 && change.files.every((file) => housekeeping.test(file))) {
    return 'other'
  }
  if (/^(fix|bugfix|hotfix)\//.test(change.branch ?? '') || fixWords.test(change.title)) {
    return 'fix'
  }
  return 'feature'
}

export function draftNotes(
  changes: Change[],
  version: string,
  previous: string | undefined,
): string {
  const line = (change: Change) =>
    `- ${change.title}${change.pullRequest === undefined ? '' : ` (#${change.pullRequest})`}`
  const section = (heading: string, kind: ChangeKind) => {
    const lines = changes.flatMap((change) => (changeKind(change) === kind ? [line(change)] : []))
    return lines.length === 0 ? [] : [`## ${heading}`, '', ...lines, '']
  }
  return [
    ...section('Features', 'feature'),
    ...section('Fixes', 'fix'),
    ...section('Other', 'other'),
    ...(previous === undefined
      ? []
      : [`**Full changelog**: https://github.com/${repo}/compare/${previous}...v${version}`, '']),
  ].join('\n')
}

export function majorEmpty(notes: string): boolean {
  const match = /^## Major[ \t]*\n([\s\S]*?)(?=^## |^\*\*Full changelog|(?![\s\S]))/m.exec(notes)
  return match !== null && /^(?:\s|<!--(?:(?!-->)[\s\S])*-->)*$/.test(match[1] ?? '')
}

const pullRequests = (text: string) => [...text.matchAll(/#(\d+)/g)].map((match) => match[1])

export function withoutMajorRepeats(notes: string): string {
  const parts = notes.split(/^(?=## )/m)
  const major = parts.find((part) => /^## Major\b/.test(part))
  const inMajor = new Set(major === undefined ? [] : pullRequests(major))
  if (inMajor.size === 0) return notes
  return parts
    .map((part) => {
      if (part === major || !part.startsWith('## ')) return part
      const blocks: string[][] = []
      for (const line of part.split('\n')) {
        const last = blocks.at(-1)
        const continues =
          last?.[0]?.startsWith('- ') && line.trim() !== '' && !line.startsWith('- ')
        if (last !== undefined && continues) last.push(line)
        else blocks.push([line])
      }
      const kept = blocks.filter((block) => {
        const numbers = pullRequests(block.join('\n'))
        return !(
          block[0]?.startsWith('- ') &&
          numbers.length > 0 &&
          numbers.every((number) => inMajor.has(number))
        )
      })
      return kept.some((block) => block[0]?.startsWith('- ')) ? kept.flat().join('\n') : ''
    })
    .join('')
    .trim()
}

export function notesPrompt(changes: Change[], version: string): string {
  const kinds: Record<ChangeKind, string> = { feature: 'feature?', fix: 'fix?', other: 'other?' }
  const lines = changes.map((change) => {
    const pr = change.pullRequest === undefined ? '' : ` (#${change.pullRequest})`
    const areas = [...new Set(change.files.map((file) => file.split('/').slice(0, 2).join('/')))]
    return `- [${kinds[changeKind(change)]}] ${change.title}${pr} — touches ${areas.slice(0, 4).join(', ')}`
  })
  return [
    `Write the release notes for Ted ${version}, a macOS desktop app that runs software factories: agents carry development tasks through a workflow, and the human steers through an inbox and comments.`,
    '',
    'Below is every change merged since the last release, one per line, with a guessed kind and the folders it touched. Use only these changes; never invent one.',
    '',
    'Answer with Markdown only, starting with the first section heading you use, in these sections and this order:',
    '- ## Major: only when some changes stand out as the ones a user will notice most; leave the section out when none do. At most four bullets, a sentence or two each. One bullet may sum up a series of changes that together make one larger change, with all their pull request numbers, like (#431, #435, #440).',
    '- ## Features: new or changed behaviour a user can see.',
    '- ## Fixes: things that were broken and now work.',
    '- ## Other: tests, docs, release tooling and internal changes, briefly; group related ones into one line.',
    'Every change goes in exactly one section: a change covered under Major never appears again in Features, Fixes or Other. Leave out a section with nothing in it. Keep pull request numbers like (#431) on the lines they belong to. Merge lines that describe the same change.',
    '',
    'Style: plain, direct language; name the concrete thing; no marketing words; curly quotes and apostrophes (’ “ ”). Write for someone who uses Ted, not someone who builds it.',
    '',
    'Changes:',
    ...lines,
  ].join('\n')
}

export function cleanClaudeNotes(answer: string): string | undefined {
  const start = answer.search(/^## (Major|Features|Fixes|Other)[ \t]*$/m)
  if (start === -1) return undefined
  const notes = answer
    .slice(start)
    .split('\n')
    .filter((line) => !/^\*\*Full changelog/i.test(line))
    .join('\n')
    .replace(/\n*```\s*$/, '')
    .trim()
  return majorEmpty(notes) ? undefined : withoutMajorRepeats(notes)
}

function claudeNotes(changes: Change[], version: string, previous: string | undefined) {
  if (changes.length === 0) return undefined
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'ted-notes-'))
  try {
    // Change titles can come from outside issues, so Claude gets no tools to act on them.
    const result = spawnSync(
      'claude',
      [
        '-p',
        '--tools',
        '',
        '--output-format',
        'text',
        '--no-session-persistence',
        '--strict-mcp-config',
      ],
      {
        cwd: scratch,
        input: notesPrompt(changes, version),
        encoding: 'utf8',
        timeout: 5 * 60_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    )
    if (result.status !== 0) return undefined
    const notes = cleanClaudeNotes(result.stdout)
    if (notes === undefined) return undefined
    const link =
      previous === undefined
        ? ''
        : `\n\n**Full changelog**: https://github.com/${repo}/compare/${previous}...v${version}`
    return `${notes}${link}\n`
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function changesSince(previous: string | undefined, head: string): Change[] {
  const range = previous === undefined ? [head, '-n', '200'] : [`${previous}..${head}`]
  const log = git('log', '--first-parent', '--format=%H%x1f%P%x1f%s%x1f%b%x1e', ...range)
  const changes: Change[] = []
  for (const record of log.split('\x1e')) {
    const [hash = '', parentList = '', subject = '', body = ''] = record.trim().split('\x1f')
    if (hash === '' || /^Release \d+\.\d+\.\d+$/.test(subject)) continue
    const parents = parentList.split(' ').filter((parent) => parent !== '')
    const files = git('diff', '--name-only', parents[0] ?? `${hash}^`, hash)
      .split('\n')
      .filter((file) => file !== '')
    const pull = /^Merge pull request #(\d+) from [^/\s]+\/(\S+)/.exec(subject)
    const branch = /^Merge branch '([^']+)'/.exec(subject)
    const merged =
      parents.length === 2
        ? git('log', '--no-merges', '--reverse', '--format=%s', `${parents[0]}..${parents[1]}`)
            .split('\n')
            .find((text) => text !== '')
        : undefined
    if (pull !== null) {
      const title =
        merged ??
        body
          .split('\n')
          .find((text) => text.trim() !== '')
          ?.trim() ??
        subject
      changes.push({ title, branch: pull[2] ?? '', pullRequest: Number(pull[1]), files })
    } else if (branch !== null) {
      changes.push({ title: merged ?? subject, branch: branch[1] ?? '', files })
    } else if (!subject.startsWith('Merge ')) {
      changes.push({ title: subject, files })
    }
  }
  return changes.reverse()
}

function isAncestor(older: string, newer: string): boolean {
  return gitMaybe('merge-base', '--is-ancestor', older, newer) !== undefined
}

function mergeBack(record: ReleaseRecord): void {
  if (record.commit === record.base) return
  const tag = `v${record.version}`
  for (let attempt = 0; attempt < 3; attempt++) {
    step('Fetch', 'git', ['fetch', 'origin', 'main'])
    const main = git('rev-parse', 'origin/main')
    if (isAncestor(record.commit, main)) return
    let commit = record.commit
    if (!isAncestor(main, record.commit)) {
      const tree = gitMaybe('merge-tree', '--write-tree', main, record.commit)
      if (tree === undefined) {
        fail(`the version change in ${tag} conflicts with main; merge ${tag} into main by hand`)
      }
      const message = `Merge ${tag} into main`
      commit = git(
        'commit-tree',
        tree.split('\n')[0] ?? '',
        '-p',
        main,
        '-p',
        record.commit,
        '-m',
        message,
      )
    }
    console.log(`\n== Put the version change on main`)
    const push = spawnSync('git', ['push', 'origin', `${commit}:refs/heads/main`], {
      cwd: root,
      stdio: 'inherit',
    })
    if (push.status === 0) return
  }
  fail(
    'main kept moving on GitHub; run pnpm release publish again to put the version change on main',
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

async function build(version: string, skipChecks: boolean): Promise<void> {
  const current = currentVersion()
  if (parseVersion(version) === undefined) fail(`“${version}” isn’t a version like 1.2.3`)
  if (git('status', '--porcelain') !== '')
    fail('the release checkout has changes; remove them first')
  const pending = readRecord()
  if (pending !== undefined && remoteTagCommit(`v${pending.version}`) === undefined) {
    fail(
      `${pending.version} is built but not published; run pnpm release publish or pnpm release discard`,
    )
  }
  step('Fetch', 'git', ['fetch', '--tags', 'origin'])
  const base = git('rev-parse', 'HEAD')
  if (git('tag', '--list', `v${version}`) !== '') fail(`tag v${version} already exists`)
  if (remoteTagCommit(`v${version}`) !== undefined) fail(`tag v${version} is already on GitHub`)
  const firstRelease = git('tag', '--list', 'v*') === ''
  if (!(isNewer(version, current) || (firstRelease && version === current)))
    fail(`${version} isn’t newer than ${current}`)
  useSigningIdentity()
  useNotaryCredentials()

  if (skipChecks) {
    console.log(
      `\n== Skipping the checks (--skip-checks): ${base.slice(0, 8)} hasn’t passed a full run`,
    )
    step('Install', 'pnpm', ['install', '--frozen-lockfile'])
  } else if (hasPassed(base)) {
    console.log('\n== Checks already passed on this commit; skipping them')
    step('Install', 'pnpm', ['install', '--frozen-lockfile'])
  } else if (!(await checkAndRecord({ all: true }))) {
    fail('checks failed')
  }

  const previous = gitMaybe('describe', '--tags', '--abbrev=0', '--match', 'v*', base)
  const changes = changesSince(previous, base)

  if (version !== current) {
    setVersion(version)
    step('Commit', 'git', ['commit', '-am', `Release ${version}`])
  }
  step('Tag', 'git', ['tag', '-a', `v${version}`, '-m', `Ted ${version}`])
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
  console.log('\n== Draft the release notes with Claude')
  const drafted = claudeNotes(changes, version, previous)
  writeFileSync(notesFile, drafted ?? draftNotes(changes, version, previous))
  console.log(
    drafted === undefined
      ? `Claude couldn’t draft them, so ${notesFile} lists the changes by kind; read them before you publish.`
      : `Claude drafted them in ${notesFile}; read and correct them before you publish.`,
  )
  install()
  console.log(
    `\nTed ${version} is built from ${base.slice(0, 8)}, tagged on this Mac only and installed in ${installed}.`,
  )
  console.log('Try it. Then run pnpm release publish to send it to everyone,')
  console.log('or pnpm release discard to throw it away and build the same version again.')
}

function releaseCheckout(): string {
  const main = path.dirname(path.resolve(root, git('rev-parse', '--git-common-dir')))
  return `${main}-release`
}

function inReleaseCheckout(): boolean {
  const checkout = releaseCheckout()
  return existsSync(checkout) && realpathSync(checkout) === realpathSync(root)
}

function inCheckout(checkout: string, title: string, command: string, args: string[]): void {
  console.log(`\n== ${title}`)
  const result = spawnSync(command, args, { cwd: checkout, stdio: 'inherit' })
  if (result.status !== 0) fail(`${title} failed`)
}

// Builds happen in their own detached worktree of origin/main, so main can keep moving here and
// on GitHub while a release is tested, built and published. It sits beside the repo, not in .git,
// because Vite refuses to serve files from inside a .git folder.
function forward(args: string[], fresh: boolean): never {
  const checkout = releaseCheckout()
  if (fresh) {
    step('Fetch', 'git', ['fetch', 'origin', 'main'])
    if (existsSync(checkout)) {
      const pendingFile = path.join(checkout, path.relative(root, recordFile))
      const pending = existsSync(pendingFile)
        ? (JSON.parse(readFileSync(pendingFile, 'utf8')) as ReleaseRecord)
        : undefined
      if (pending !== undefined && remoteTagCommit(`v${pending.version}`) === undefined) {
        fail(
          `${pending.version} is built but not published; run pnpm release publish or pnpm release discard`,
        )
      }
      if (
        execFileSync('git', ['status', '--porcelain'], { cwd: checkout, encoding: 'utf8' }) !== ''
      ) {
        fail(`the release checkout at ${checkout} has changes; remove them first`)
      }
      inCheckout(checkout, 'Check out origin/main', 'git', [
        'checkout',
        '--quiet',
        '--detach',
        'origin/main',
      ])
    } else {
      step('Prune old worktrees', 'git', ['worktree', 'prune'])
      step('Check out origin/main', 'git', ['worktree', 'add', '--detach', checkout, 'origin/main'])
    }
    inCheckout(checkout, 'Install', 'pnpm', ['install', '--frozen-lockfile'])
  } else if (!existsSync(checkout)) {
    fail('there’s no release checkout yet; run pnpm release <version> first')
  }
  const script = path.join(checkout, 'scripts/release.ts')
  const result = spawnSync(process.execPath, [script, ...args], { cwd: checkout, stdio: 'inherit' })
  if (result.status === 0 && args.includes('publish')) pullMain()
  process.exit(result.status ?? 1)
}

export interface WebsiteRelease {
  version: string
  updated: string
  download: string
}

export function websiteRelease(record: ReleaseRecord, published: Date): WebsiteRelease {
  const dmg = Object.keys(record.files).find((name) => name.endsWith('.dmg'))
  if (dmg === undefined) throw new Error(`the build of ${record.version} has no .dmg`)
  return {
    version: `v${record.version}`,
    updated: published.toLocaleDateString('en-US', { month: 'long', day: 'numeric' }),
    download: `https://github.com/${repo}/releases/download/v${record.version}/${encodeURIComponent(dmg)}`,
  }
}

const websiteFile = 'src/data/release.json'

// The website deploys every push to its main, so the release is committed there from a scratch
// worktree of origin/main and the website checkout, which may hold other work, is left alone.
function updateWebsite(record: ReleaseRecord): void {
  const website = process.env.TED_WEBSITE_DIR || path.join(os.homedir(), 'Websites/ted-and-bill')
  if (!existsSync(path.join(website, websiteFile))) {
    console.log(`\nNo ${websiteFile} in ${website}; update the website yourself.`)
    return
  }
  const facts = websiteRelease(record, new Date())
  const run = (dir: string, title: string, args: string[]): boolean => {
    console.log(`\n== ${title}`)
    return spawnSync('git', args, { cwd: dir, stdio: 'inherit' }).status === 0
  }
  const scratch = path.join(mkdtempSync(path.join(os.tmpdir(), 'ted-website-')), 'site')
  if (
    !run(website, 'Fetch the website', ['fetch', 'origin', 'main']) ||
    !run(website, 'Check out the website', ['worktree', 'add', '--detach', scratch, 'origin/main'])
  ) {
    fail('couldn’t check out the website; run pnpm release publish again to retry')
  }
  let outcome: 'pushed' | 'current' | 'failed' = 'failed'
  try {
    const file = path.join(scratch, websiteFile)
    const current = JSON.parse(readFileSync(file, 'utf8')) as WebsiteRelease
    if (current.version === facts.version && current.download === facts.download) {
      outcome = 'current'
    } else {
      writeFileSync(file, `${JSON.stringify(facts, null, 2)}\n`)
      const message = `Offer Ted ${facts.version}`
      if (run(scratch, 'Commit the website', ['commit', '-qm', message, '--', websiteFile])) {
        for (let attempt = 0; attempt < 3 && outcome === 'failed'; attempt++) {
          if (attempt > 0) {
            const caughtUp =
              run(scratch, 'Fetch the website', ['fetch', 'origin', 'main']) &&
              run(scratch, 'Rebase the website change', ['rebase', 'origin/main'])
            if (!caughtUp) break
          }
          if (run(scratch, 'Push the website', ['push', 'origin', 'HEAD:refs/heads/main'])) {
            outcome = 'pushed'
          }
        }
      }
    }
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', scratch], { cwd: website, stdio: 'inherit' })
  }
  if (outcome === 'failed') {
    fail('couldn’t update the website; run pnpm release publish again to retry')
  }
  if (outcome === 'current') {
    console.log(`\nThe website already offers ${facts.version}.`)
    return
  }
  console.log(
    `\nThe website now offers ${facts.version}; Cloudflare deploys it in a minute or two.`,
  )
  const branch = execFileSync('git', ['branch', '--show-current'], {
    cwd: website,
    encoding: 'utf8',
  }).trim()
  if (branch === 'main') {
    spawnSync('git', ['pull', '--ff-only', '--quiet', 'origin', 'main'], {
      cwd: website,
      stdio: 'inherit',
    })
  }
}

function pullMain(): void {
  if (git('branch', '--show-current') !== 'main') {
    console.log('\nThis checkout isn’t on main; pull main yourself to get the version change.')
    return
  }
  console.log('\n== Pull main')
  const pull = spawnSync('git', ['pull', '--ff-only', 'origin', 'main'], {
    cwd: root,
    stdio: 'inherit',
  })
  if (pull.status !== 0) console.log('Couldn’t fast-forward main here; run git pull yourself.')
}

export type ReleaseAction =
  | { action: 'publish' }
  | { action: 'discard' }
  | { action: 'build'; version: string }
  | { refusal: string }

export function releaseAction(args: readonly string[]): ReleaseAction | undefined {
  const [command, version] = args.filter((arg) => !arg.startsWith('--'))
  if (command === undefined) return undefined
  if (command === 'publish') return { action: 'publish' }
  if (command === 'discard') return { action: 'discard' }
  const named = command === 'build' ? version : command
  if (named === undefined) return { refusal: 'pnpm release build needs a version like 1.2.3' }
  if (parseVersion(named) === undefined) return { refusal: `“${named}” isn’t a version like 1.2.3` }
  return { action: 'build', version: named }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const installing = args.includes('--install')
  const chosen = releaseAction(args)
  if (!installing && chosen !== undefined && 'refusal' in chosen) fail(chosen.refusal)
  if (!inReleaseCheckout() && (chosen !== undefined || installing)) {
    forward(
      args,
      !installing && chosen !== undefined && 'action' in chosen && chosen.action === 'build',
    )
  }
  if (installing) return install()
  if (chosen === undefined || 'refusal' in chosen) {
    return fail(
      `usage: pnpm release [build] <version> [--skip-checks] | publish | discard | --install (now ${currentVersion()})`,
    )
  }
  if (chosen.action === 'publish') return publish()
  if (chosen.action === 'discard') return discard()
  await build(chosen.version, args.includes('--skip-checks'))
}

if (import.meta.main) await main()
