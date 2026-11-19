import { expect, test } from 'vitest'
import {
  approvedOutsideSandbox,
  parseOutsideSandboxApprovalsRequest,
  readOutsideSandboxApprovals,
  withOutsideSandboxApproval,
} from '../src/index.ts'
import { rejects } from './parser-cases.ts'

const hash = (digit: string) => digit.repeat(64)
const api = { repo: 'widgets', app: 'API', declaration: hash('a') }
const web = { repo: 'widgets', app: 'Web', declaration: hash('b') }

test('parseOutsideSandboxApprovalsRequest reads every field and keeps the last entry per App', () => {
  expect(
    parseOutsideSandboxApprovalsRequest({
      f1: [api, web, { ...api, declaration: hash('c') }],
      f2: [],
    }),
  ).toEqual({ f1: [{ ...api, declaration: hash('c') }, web], f2: [] })
})

const problem =
  'appsOutsideSandbox lists, for each Factory, Apps as { repo, app, declaration } with a SHA-256 declaration'
rejects(
  parseOutsideSandboxApprovalsRequest,
  [],
  'appsOutsideSandbox must be an object of approved Apps by Factory ID',
)
test.each([
  ['a name-only approval', { f1: ['API'] }],
  ['a declaration that isn’t a SHA-256', { f1: [{ ...api, declaration: 'abc' }] }],
  ['an empty repo', { f1: [{ ...api, repo: '' }] }],
  ['a missing App name', { f1: [{ repo: 'widgets', declaration: hash('a') }] }],
  ['a list that isn’t one', { f1: api }],
  ['more than 100 Apps', { f1: Array(101).fill(api) }],
])('parseOutsideSandboxApprovalsRequest rejects %s', (_, body) => {
  expect(() => parseOutsideSandboxApprovalsRequest(body)).toThrow(problem)
})

test('readOutsideSandboxApprovals drops name-only approvals saved before Apps were fingerprinted', () => {
  expect(readOutsideSandboxApprovals({ f1: ['API', 'Web'], f2: ['API', web], f3: 'x' })).toEqual({
    f2: [web],
  })
  expect(readOutsideSandboxApprovals(undefined)).toEqual({})
})

test('an approval counts only for the same repo, App and declaration', () => {
  expect(approvedOutsideSandbox([api], api)).toBe(true)
  expect(approvedOutsideSandbox([api], { ...api, declaration: hash('d') })).toBe(false)
  expect(approvedOutsideSandbox([api], { ...api, repo: 'gadgets' })).toBe(false)
  expect(approvedOutsideSandbox(undefined, api)).toBe(false)
})

test('withOutsideSandboxApproval replaces the App’s earlier approval', () => {
  const newer = { ...api, declaration: hash('e') }
  expect(withOutsideSandboxApproval([api, web], newer)).toEqual([web, newer])
  expect(withOutsideSandboxApproval(undefined, api)).toEqual([api])
})
