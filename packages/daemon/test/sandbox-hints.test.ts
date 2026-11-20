import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { appendRefusalHints, refusalHints, refusedGroups } from '../src/sandbox-hints.ts'

const temp = '/var/folders/ab/cd1234/T'
const nsird = `error: couldn’t create ${temp}/TemporaryItems/NSIRD_xcodebuild_AbCdEf: Operation not permitted`
const manifest = `/Users/someone/Library/Caches/org.swift.swiftpm/manifests/ManifestLoading/Pkg.dia: Permission denied`

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

test('a refused Xcode path in the per-user temp folder or ManifestLoading names ios-xcode', () => {
  expect(refusedGroups(nsird)).toEqual(['ios-xcode'])
  expect(refusedGroups(manifest)).toEqual(['ios-xcode'])
  expect(
    refusedGroups(`/private${temp}/TemporaryDirectory.a1B2c3: Operation not permitted`),
  ).toEqual(['ios-xcode'])
})

test('a refused rendered icon or its ImageIO temp file names ios-xcode', () => {
  const icon = 'AppIcon_0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0-4242-0123456789ABCDEF.png'
  expect(refusedGroups(`${temp}/${icon}: Operation not permitted`)).toEqual(['ios-xcode'])
  expect(refusedGroups(`${temp}/.${icon}-a1B2c3: Operation not permitted`)).toEqual(['ios-xcode'])
})

test('a refusal elsewhere, or a group path without a refusal, gives no hint', () => {
  expect(refusedGroups('/Users/someone/.ssh/id_ed25519: Operation not permitted')).toEqual([])
  expect(refusedGroups(`${temp}/xcrun_db: Operation not permitted`)).toEqual([])
  expect(refusedGroups(`writing ${temp}/TemporaryItems/NSIRD_xcodebuild_AbCdEf`)).toEqual([])
})

test('the hint names the group and who lacks it, once, and not when the command has the group', () => {
  const hints = refusalHints(`${nsird}\n${manifest}\n`, [], 'the App “iOS simulator”')
  expect(hints).toEqual([
    'Ted: the sandbox refused something in the ios-xcode access group, which the App “iOS simulator” doesn’t have. Propose sandbox_access: [ios-xcode] for it in .ted/workflow.yaml instead of working around the refusal; it takes effect once the user merges or approves it.',
  ])
  expect(refusalHints(nsird, ['ios-xcode'], 'the App “iOS simulator”')).toEqual([])
})

test('a refused connect or a failed lookup names network, and the hint says what it allows', () => {
  expect(refusedGroups('Error: connect EPERM 192.0.2.1:443 - Local (0.0.0.0:0)')).toEqual([
    'network',
  ])
  expect(
    refusedGroups(
      'npm error request to https://registry.npmjs.org/x failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org',
    ),
  ).toEqual(['network'])
  expect(refusedGroups('curl: (6) Could not resolve host: example.com')).toEqual(['network'])
  expect(refusedGroups('connect ECONNREFUSED 127.0.0.1:5432')).toEqual([])
  expect(
    refusalHints('getaddrinfo ENOTFOUND registry.npmjs.org', [], 'the worktree setup'),
  ).toEqual([
    'Ted: the sandbox refused a connection or lookup outside this machine. The network access group allows it, and the worktree setup doesn’t have it. Propose sandbox_access: [network] for it in .ted/workflow.yaml instead of working around the refusal; it takes effect once the user merges or approves it.',
  ])
  expect(refusalHints('connect EPERM 192.0.2.1:443', ['network'], 'the App “Web”')).toEqual([])
})

test('a refused Electron service names the electron group, and a socket the Library lacks gets its own line', () => {
  const lookup =
    'Check in with com.apple.coreservices.launchservicesd failed: Operation not permitted'
  expect(refusedGroups(lookup)).toEqual(['electron'])
  expect(refusalHints(lookup, ['electron'], 'the Check “E2E”')).toEqual([])
  expect(refusalHints('', ['socket:docker'], 'the Check “E2E”', ['docker'])).toEqual([
    'Ted: the Check “E2E” asks for socket:docker, but the user’s Library names no socket docker, so the sandbox gave it none. The user adds docker: <socket path> under sandbox_sockets in the Library’s workflow.yaml.',
  ])
})

test('the hint goes on its own line at the end of the command’s log', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ted-hints-'))
  dirs.push(dir)
  const log = path.join(dir, 'build.log')
  await writeFile(log, nsird)
  await appendRefusalHints(log, [], 'the Check “Build”')
  const lines = (await readFile(log, 'utf8')).split('\n')
  expect(lines[0]).toBe(nsird)
  expect(lines[1]).toContain('which the Check “Build” doesn’t have')
  expect(lines[2]).toBe('')
})

const tmpRefusal = "EPERM: operation not permitted, open '/tmp/build.lock'"

test('on macOS a refused path in the shared /tmp names shared-tmp, but a folder merely called tmp does not', () => {
  expect(refusedGroups('touch: /private/tmp/ted-x: Operation not permitted', 'darwin')).toEqual([
    'shared-tmp',
  ])
  expect(refusedGroups(tmpRefusal, 'darwin')).toEqual(['shared-tmp'])
  expect(
    refusedGroups('/Users/someone/.ted/sandbox/TED-1/tmp/x: Operation not permitted', 'darwin'),
  ).toEqual([])
  expect(refusedGroups('writing /tmp/build.lock', 'darwin')).toEqual([])
})

test('on Linux a refused /tmp path gives no shared-tmp hint, because /tmp is the command’s own temp folder there', () => {
  expect(refusedGroups(tmpRefusal, 'linux')).toEqual([])
  expect(refusalHints(tmpRefusal, [], 'the Check “Build”', [], 'linux')).toEqual([])
  expect(refusedGroups(nsird, 'linux')).toEqual(['ios-xcode'])
})
