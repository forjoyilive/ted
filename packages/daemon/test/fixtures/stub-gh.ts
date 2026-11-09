#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs'

interface StubState {
  version?: string
  hosts?: Record<string, unknown[]>
  api?: { result: 'ok' | 'rate-limit' | 'auth'; body?: unknown }
  paths?: Record<string, { status?: number; message?: string; body?: unknown }>
}

const readyHosts = {
  'github.com': [
    {
      state: 'success',
      active: true,
      host: 'github.com',
      login: 'stub-user',
      tokenSource: 'keyring',
      scopes: 'gist, read:org, repo, workflow',
      gitProtocol: 'https',
    },
  ],
}

const statePath = process.env.TED_STUB_GH
const state: StubState = statePath ? JSON.parse(readFileSync(statePath, 'utf8')) : {}
const args = process.argv.slice(2)

const logPath = process.env.TED_STUB_GH_LOG
if (logPath) {
  const stdin = args.includes('--input') ? readFileSync(0, 'utf8') : undefined
  appendFileSync(
    logPath,
    `${JSON.stringify({
      args,
      env: {
        GH_PROMPT_DISABLED: process.env.GH_PROMPT_DISABLED,
        GH_NO_UPDATE_NOTIFIER: process.env.GH_NO_UPDATE_NOTIFIER,
        GH_HOST: process.env.GH_HOST,
      },
      ...(stdin !== undefined && { stdin }),
    })}\n`,
  )
}

if (args[0] === '--version') {
  const version = state.version ?? '2.89.0'
  process.stdout.write(
    `gh version ${version} (2026-03-26)\nhttps://github.com/cli/cli/releases/tag/v${version}\n`,
  )
} else if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(`${JSON.stringify({ hosts: state.hosts ?? readyHosts })}\n`)
} else if (args[0] === 'api' && state.paths) {
  const route = args.find((arg, i) => i > 0 && !arg.startsWith('-') && args[i - 1] !== '--method')
  const answer = route === undefined ? undefined : state.paths[route]
  if (!answer || (answer.status ?? 200) >= 400) {
    const status = answer?.status ?? 404
    process.stderr.write(`gh: ${answer?.message ?? 'Not Found'} (HTTP ${status})\n`)
    process.exit(1)
  }
  process.stdout.write(`${JSON.stringify(answer.body ?? {})}\n`)
} else if (args[0] === 'api') {
  const result = state.api?.result ?? 'ok'
  if (result === 'rate-limit') {
    process.stderr.write('gh: API rate limit exceeded for user ID 1. (HTTP 403)\n')
    process.exit(1)
  }
  if (result === 'auth') {
    process.stderr.write('gh: Bad credentials (HTTP 401)\n')
    process.exit(1)
  }
  process.stdout.write(`${JSON.stringify(state.api?.body ?? {})}\n`)
} else {
  process.stderr.write(`stub gh: unknown command ${args.join(' ')}\n`)
  process.exit(1)
}
