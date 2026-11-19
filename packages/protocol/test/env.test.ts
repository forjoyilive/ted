import { globSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
  filterTedEnv,
  outsideTedEnv,
  remoteExecutionOn,
  tedEnv,
  tedEnvironment,
} from '../src/env.ts'

test('release accepts only reviewed Ted inputs; Dev keeps every test hook', () => {
  for (const [name, reason] of Object.entries(tedEnvironment)) {
    const env = { [name]: 'provided' }
    expect(tedEnv(name, env, 'dev'), name).toBe('provided')
    expect(tedEnv(name, env, 'release'), name).toBe(reason === false ? undefined : 'provided')
    expect(filterTedEnv(env, 'release'), name).toEqual(reason === false ? {} : env)
    if (reason !== false) expect(reason.length).toBeGreaterThan(20)
  }
})

test('remote execution is on only in Dev with TED_REMOTE_EXECUTION=on', () => {
  expect(remoteExecutionOn({ TED_REMOTE_EXECUTION: 'on' }, 'dev')).toBe(true)
  expect(remoteExecutionOn({ TED_REMOTE_EXECUTION: 'on' }, 'release')).toBe(false)
  expect(remoteExecutionOn({ TED_REMOTE_EXECUTION: '1' }, 'dev')).toBe(false)
  expect(remoteExecutionOn({}, 'dev')).toBe(false)
})

test('new hooks default to Dev-only, including inherited and supplied environment objects', () => {
  const env = {
    TED_FUTURE_TEST_HOOK: 'arbitrary code',
    TED_KEYRING_MODULE: '/untrusted/module.js',
    TED_HOME: '/home/ted',
    TED_APP_WEB_PORT: '3000',
    TED_APP_WEB_URL: 'http://localhost:3000',
    PATH: '/bin',
    ted_keyring_module: 'case variant',
  }
  expect(tedEnv('TED_FUTURE_TEST_HOOK', env, 'release')).toBeUndefined()
  expect(tedEnv('TED_FUTURE_TEST_HOOK', env, 'dev')).toBe('arbitrary code')
  expect(filterTedEnv(env, 'release')).toEqual({
    TED_HOME: '/home/ted',
    TED_APP_WEB_PORT: '3000',
    TED_APP_WEB_URL: 'http://localhost:3000',
    PATH: '/bin',
  })
  expect(filterTedEnv(env, 'dev')).toEqual(env)
  expect(env.TED_KEYRING_MODULE).toBe('/untrusted/module.js')
  expect(tedEnv('toString', env, 'release')).toBeUndefined()

  expect(outsideTedEnv('SSH_AUTH_SOCK', { SSH_AUTH_SOCK: '/tmp/agent' })).toBe('/tmp/agent')
  expect(outsideTedEnv('TED_APP_TOKEN', { TED_APP_TOKEN: 'secret' })).toBeUndefined()
  expect(outsideTedEnv('ted_app_token', { ted_app_token: 'secret' })).toBeUndefined()
})

function rawReads(source: string): string[] {
  const reads: string[] = []
  const aliases = new Set(['process\\.env', 'env', 'base'])
  for (const match of source.matchAll(
    /\b(?:const|let)\s+(\w+)\s*=\s*(process\.env|env|base)(?=\s*(?:;|\n|$))/g,
  )) {
    if (match[1]) aliases.add(match[1])
  }
  const environments = `(?:${[...aliases].join('|')})`
  const accesses = new RegExp(
    `(?:\\b[\\w.?]+\\s*\\.\\s*TED_\\w+|\\b${environments}\\s*(?:\\?\\.)?\\s*\\[[^\\]\\n]+\\])`,
    'g',
  )
  for (const match of source.matchAll(accesses)) {
    const before = source.slice(0, match.index)
    const after = source.slice(match.index + match[0].length)
    if (/\bdelete\s*$/.test(before) || /^\s*=(?!=)/.test(after)) continue
    reads.push(match[0])
  }
  for (const match of source.matchAll(
    new RegExp(`\\{[^{}]*\\bTED_\\w+[^{}]*\\}\\s*=\\s*${environments}`, 'g'),
  )) {
    reads.push(match[0])
  }
  return reads
}

test('the guard catches new direct, computed, aliased and destructured reads', () => {
  for (const source of [
    'const hook = process.env.TED_NEW_HOOK',
    "const hook = process.env['TED_NEW_HOOK']",
    "const key = 'TED_NEW_HOOK'; const hook = process.env[key]",
    'const hook = env[name]',
    "const alias = process.env; const hook = alias['TED_NEW_HOOK']",
    'const hook = process.env?.TED_NEW_HOOK',
    'const alias = process.env; const hook = alias.TED_NEW_HOOK',
    'const { TED_NEW_HOOK: hook } = process.env',
  ])
    expect(rawReads(source), source).not.toEqual([])
  expect(rawReads('delete process.env.TED_NEW_HOOK')).toEqual([])
  expect(rawReads("process.env.TED_TASK = 'NB-1'")).toEqual([])
})

const notEnvironmentNames = {
  TED_COMMAND_SCRIPT: 'marker in the shell script command-line.ts writes, not an environment input',
  TED_APP_READY:
    'line a simulator or emulator App prints when its build is ready, read from its log',
}

test('runtime Ted environment reads use the central policy and name classified inputs', () => {
  const root = path.resolve(import.meta.dirname, '../../..')
  const findings: string[] = []
  for (const file of globSync('packages/*/src/**/*.{ts,tsx,cjs}', { cwd: root })) {
    if (file === 'packages/protocol/src/env.ts') continue
    const source = readFileSync(path.join(root, file), 'utf8')
    findings.push(...rawReads(source).map((read) => `${file}: ${read}`))
    for (const match of source.matchAll(/['"](TED_[A-Z0-9_]+)['"]/g)) {
      const name = match[1] ?? ''
      if (Object.hasOwn(notEnvironmentNames, name)) continue
      if (!Object.hasOwn(tedEnvironment, name)) findings.push(`${file}: ${name}`)
    }
  }
  expect(findings).toEqual([])
})
