import { expect, test } from 'vitest'
import { sandboxOpenings, sandboxSummary } from '../src/sandbox-openings.ts'

const none = {
  permissions: 'auto',
  appsOutsideSandbox: [],
  piUnsandboxedAllowed: false,
  sockets: [],
  electronApps: [],
} as const

test('a Factory with nothing open has no rows and a closed summary', () => {
  const openings = sandboxOpenings(none)
  expect(openings).toEqual([])
  expect(sandboxSummary(openings)).toEqual({ kind: 'closed' })
})

test('Library sockets and Electron Apps widen the sandbox without running anything outside it', () => {
  const openings = sandboxOpenings({
    ...none,
    sockets: [{ name: 'a', path: '/a.sock' }],
    electronApps: [{ repo: 'ted', name: 'Ted Dev' }],
  })
  expect(openings).toEqual([
    { kind: 'socket', unsandboxed: false, socket: 'a', path: '/a.sock', from: 'library' },
    { kind: 'electron-app', unsandboxed: false, repo: 'ted', app: 'Ted Dev' },
  ])
  expect(sandboxSummary(openings)).toEqual({ kind: 'widened', count: 2 })
})

test('a simulator or emulator App is a row naming the access group its kind gives it', () => {
  const openings = sandboxOpenings({
    ...none,
    deviceApps: [
      { repo: 'app', name: 'iPhone', group: 'ios-simulator' },
      { repo: 'app', name: 'Pixel', group: 'android-emulator' },
    ],
  })
  expect(openings).toEqual([
    { kind: 'device-app', unsandboxed: false, repo: 'app', app: 'iPhone', group: 'ios-simulator' },
    {
      kind: 'device-app',
      unsandboxed: false,
      repo: 'app',
      app: 'Pixel',
      group: 'android-emulator',
    },
  ])
  expect(sandboxSummary(openings)).toEqual({ kind: 'widened', count: 2 })
})

test('unsandboxed items come first and are counted', () => {
  const openings = sandboxOpenings({
    ...none,
    permissions: 'bypass',
    appsOutsideSandbox: [{ repo: 'ted', app: 'Ted Dev', declaration: 'a'.repeat(64) }],
    sockets: [{ name: 'a', path: '/a.sock' }],
  })
  expect(openings.map((o) => o.kind)).toEqual(['bypass', 'app-outside', 'socket'])
  expect(sandboxSummary(openings)).toEqual({ kind: 'unsandboxed', count: 2 })
})

test('Pi’s unsandboxed fallback shows only in an Auto Factory', () => {
  expect(sandboxOpenings({ ...none, piUnsandboxedAllowed: true })).toEqual([
    { kind: 'pi-unsandboxed', unsandboxed: true },
  ])
  expect(
    sandboxOpenings({ ...none, permissions: 'bypass', piUnsandboxedAllowed: true }).map(
      (o) => o.kind,
    ),
  ).toEqual(['bypass'])
})

test('a socket row names the layer that names it', () => {
  expect(
    sandboxOpenings({ ...none, sockets: [{ name: 'a', path: '/a.sock' }], socketsFrom: 'ted' }),
  ).toEqual([{ kind: 'socket', unsandboxed: false, socket: 'a', path: '/a.sock', from: 'ted' }])
})

test('each access group an App, Check or setup has is its own row, and widens the sandbox', () => {
  const openings = sandboxOpenings({
    ...none,
    access: [
      { kind: 'app', repo: 'mobile', name: 'iOS simulator', groups: ['ios-xcode', 'ios-xcode'] },
      { kind: 'check', name: 'Lint', groups: [] },
      { kind: 'setup', repo: 'mobile', name: 'setup', groups: ['ios-xcode'] },
    ],
  })
  expect(openings).toEqual([
    {
      kind: 'access-group',
      unsandboxed: false,
      holder: 'app',
      repo: 'mobile',
      name: 'iOS simulator',
      group: 'ios-xcode',
    },
    {
      kind: 'access-group',
      unsandboxed: false,
      holder: 'setup',
      repo: 'mobile',
      name: 'setup',
      group: 'ios-xcode',
    },
  ])
  expect(sandboxSummary(openings)).toEqual({ kind: 'widened', count: 2 })
})

test('outbound network for the whole Factory widens the sandbox, before the access groups', () => {
  const openings = sandboxOpenings({
    ...none,
    networkFrom: 'library',
    access: [{ kind: 'check', name: 'E2E', groups: ['network'] }],
  })
  expect(openings.map((o) => o.kind)).toEqual(['network', 'access-group'])
  expect(openings[0]).toEqual({ kind: 'network', unsandboxed: false, from: 'library' })
  expect(sandboxSummary(openings)).toEqual({ kind: 'widened', count: 2 })
})
