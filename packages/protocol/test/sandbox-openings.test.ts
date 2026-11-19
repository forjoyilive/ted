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

test('sockets and Electron Apps widen the sandbox without running anything outside it', () => {
  const openings = sandboxOpenings({
    ...none,
    sockets: ['/a.sock', '/a.sock'],
    electronApps: [{ repo: 'ted', name: 'Ted Dev' }],
  })
  expect(openings).toEqual([
    { kind: 'socket', unsandboxed: false, socket: '/a.sock' },
    { kind: 'electron-app', unsandboxed: false, repo: 'ted', app: 'Ted Dev' },
  ])
  expect(sandboxSummary(openings)).toEqual({ kind: 'widened', count: 2 })
})

test('unsandboxed items come first and are counted', () => {
  const openings = sandboxOpenings({
    ...none,
    permissions: 'bypass',
    appsOutsideSandbox: ['Ted Dev'],
    sockets: ['/a.sock'],
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
