import { describe, expect, test } from 'vitest'
import { createAgents } from '../src/agents/index.ts'

const agents = createAgents({ claudeBin: '/nowhere/claude', codexBin: '/nowhere/codex' })
const run = {
  prompt: 'Carry on',
  runDir: '/tmp/run',
  env: { PATH: '/bin' },
  permissions: 'auto' as const,
}

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

describe('agent kinds', () => {
  test('auto: Claude Code in auto mode with prompts on stdio; Codex in workspace-write on-request', () => {
    const claude = agents.get('claude').launch(run).args
    const codex = agents.get('codex').launch(run).args

    expect(after(claude, '--permission-mode')).toBe('auto')
    expect(after(claude, '--permission-prompt-tool')).toBe('stdio')
    expect(codex).toEqual(
      expect.arrayContaining(['sandbox_mode="workspace-write"', 'approval_policy="on-request"']),
    )
  })

  test('bypass: Claude Code bypassPermissions; Codex danger-full-access with no approvals', () => {
    const claude = agents.get('claude').launch({ ...run, permissions: 'bypass' }).args
    const codex = agents.get('codex').launch({ ...run, permissions: 'bypass' }).args

    expect(after(claude, '--permission-mode')).toBe('bypassPermissions')
    expect(codex).toEqual(
      expect.arrayContaining(['sandbox_mode="danger-full-access"', 'approval_policy="never"']),
    )
    expect(codex.join(' ')).not.toContain('workspace-write')
    expect(codex.join(' ')).not.toContain('on-request')
  })

  test('auto: Claude Code may run the ted command without asking; bypass needs no rule', () => {
    const settings = (permissions: 'auto' | 'bypass') =>
      JSON.parse(
        agents.get('claude').launch({ ...run, permissions }).files['settings.json'] ?? '{}',
      ) as { permissions?: { allow?: string[] }; hooks?: unknown }

    expect(settings('auto').permissions).toEqual({ allow: ['Bash(ted *)'] })
    expect(settings('auto').hooks).toBeDefined()
    expect(settings('bypass').permissions).toBeUndefined()
  })

  test('Codex keeps network access in its sandbox, so ted reaches the daemon without asking', () => {
    const codex = agents.get('codex').launch(run).args
    expect(codex).toContain('sandbox_workspace_write.network_access=true')
    expect(codex.join(' ')).not.toContain('danger-full-access')
  })

  test('Claude Code’s init line says whether auto mode took effect', () => {
    const claude = agents.get('claude')
    const init = (permissionMode: string) =>
      JSON.stringify({ type: 'system', subtype: 'init', permissionMode })
    expect(claude.autoModeFrom(init('default'))).toBe('unavailable')
    expect(claude.autoModeFrom(init('auto'))).toBe('on')
    expect(claude.autoModeFrom(init('bypassPermissions'))).toBeUndefined()
    expect(claude.autoModeFrom(JSON.stringify({ type: 'assistant' }))).toBeUndefined()
    expect(agents.get('codex').autoModeFrom(init('default'))).toBeUndefined()
  })

  test('Claude Code resumes its session with --resume and the same per-Run flags', () => {
    const fresh = agents.get('claude').launch(run)
    const resumed = agents.get('claude').launch({ ...run, resume: 'session-1' })

    expect(fresh.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(fresh.args[fresh.args.indexOf('--session-id') + 1]).toBe(fresh.sessionId)
    expect(resumed.sessionId).toBe('session-1')
    expect(resumed.args).not.toContain('--session-id')
    expect(resumed.args[resumed.args.indexOf('--resume') + 1]).toBe('session-1')
    expect(resumed.args).toContain('--settings')
  })

  test('Codex resumes its thread with thread/resume and the same per-Run flags', () => {
    const fresh = agents.get('codex').launch(run)
    const resumed = agents.get('codex').launch({ ...run, resume: 'thread-1' })

    expect(fresh.sessionId).toBeUndefined()
    expect(JSON.parse(fresh.input).thread).toEqual({ method: 'thread/start', params: {} })
    expect(resumed.sessionId).toBe('thread-1')
    expect(JSON.parse(resumed.input)).toMatchObject({
      thread: { method: 'thread/resume', params: { threadId: 'thread-1' } },
      prompt: 'Carry on',
    })
    expect(resumed.args).toEqual(fresh.args)
  })

  test('Claude Code gets the model and effort as --model and --effort, ultra as max', () => {
    const plain = agents.get('claude').launch(run)
    const chosen = agents.get('claude').launch({ ...run, model: 'opus', effort: 'high' })
    const ultra = agents.get('claude').launch({ ...run, effort: 'ultra' })

    expect(plain.args).not.toContain('--model')
    expect(plain.args).not.toContain('--effort')
    expect(chosen.args[chosen.args.indexOf('--model') + 1]).toBe('opus')
    expect(chosen.args[chosen.args.indexOf('--effort') + 1]).toBe('high')
    expect(ultra.args[ultra.args.indexOf('--effort') + 1]).toBe('max')
  })

  test('neither agent launches with a model that isn’t a plain model name', () => {
    for (const kind of ['claude', 'codex'] as const) {
      expect(() => agents.get(kind).launch({ ...run, model: '--settings=/tmp/x' })).toThrow(
        /model name/,
      )
      expect(() => agents.get(kind).launch({ ...run, model: 'opus[1m]' })).not.toThrow()
    }
  })

  test('Codex gets the model and effort in its plan', () => {
    const plain = JSON.parse(agents.get('codex').launch(run).input)
    const chosen = JSON.parse(
      agents.get('codex').launch({ ...run, model: 'gpt-6-astra', effort: 'ultra' }).input,
    )

    expect(plain.model).toBeUndefined()
    expect(plain.effort).toBeUndefined()
    expect(chosen).toMatchObject({ model: 'gpt-6-astra', effort: 'ultra' })
  })

  test('each kind knows its own model-unavailable error', () => {
    const claudeLine = JSON.stringify({
      type: 'assistant',
      error: 'model_not_found',
      message: { content: [{ type: 'text', text: 'There’s an issue with the selected model' }] },
    })
    const codexLine = JSON.stringify({
      method: 'error',
      params: {
        error: {
          message:
            '{"type":"error","status":400,"error":{"message":"The model is not supported","code":"model_not_found"}}',
        },
        willRetry: false,
      },
    })
    expect(agents.get('claude').problemFrom(claudeLine)).toBe('model-unavailable')
    expect(agents.get('claude').problemFrom(codexLine)).toBeUndefined()
    expect(agents.get('codex').problemFrom(codexLine)).toBe('model-unavailable')
    expect(agents.get('codex').problemFrom(claudeLine)).toBeUndefined()
  })

  test('the Task Lead defaults to Claude Code, or Codex when only Codex is installed', () => {
    const stub = process.execPath
    expect(createAgents({ claudeBin: stub, codexBin: stub }).defaultLead()).toBe('claude')
    expect(createAgents({ claudeBin: '/nowhere/claude', codexBin: stub }).defaultLead()).toBe(
      'codex',
    )
    expect(createAgents({ claudeBin: stub, codexBin: '/nowhere/codex' }).defaultLead()).toBe(
      'claude',
    )
    expect(
      createAgents({ claudeBin: '/nowhere/claude', codexBin: '/nowhere/codex' }).defaultLead(),
    ).toBe('claude')
  })
})

describe('usage, credentials and cost', () => {
  const claude = agents.get('claude')
  const codex = agents.get('codex')
  const line = (value: unknown) => JSON.stringify(value)

  test('Codex reports its usage limit with or without a reset time, and retries on willRetry', () => {
    expect(
      codex.usageFrom(
        line({
          method: 'error',
          params: { error: { message: 'x', codexErrorInfo: 'usageLimitExceeded' } },
        }),
      ),
    ).toEqual({ limited: true })
    expect(
      codex.usageFrom(
        line({
          method: 'turn/completed',
          params: {
            turn: {
              error: { codexErrorInfo: { usageLimitExceeded: { resetsAt: 1_800_000_000 } } },
            },
          },
        }),
      ),
    ).toEqual({ limited: true, resetsAt: new Date(1_800_000_000_000).toISOString() })
    expect(codex.usageFrom(line({ method: 'turn/completed', params: { turn: {} } }))).toEqual({
      limited: false,
    })
    expect(codex.retryingFrom(line({ method: 'error', params: { willRetry: true } }))).toBe(true)
    expect(codex.retryingFrom(line({ method: 'item/completed', params: {} }))).toBe(false)
  })

  test('Claude retries only count for rate limits and overload', () => {
    const retry = (status: number) =>
      claude.retryingFrom(line({ type: 'system', subtype: 'api_retry', error_status: status }))
    expect(retry(429)).toBe(true)
    expect(retry(529)).toBe(true)
    expect(retry(500)).toBe(false)
  })

  test('each kind reports the credential a Run started with', () => {
    expect(
      claude.credentialFrom(line({ type: 'system', subtype: 'init', apiKeySource: 'none' })),
    ).toEqual({ billing: 'subscription' })
    expect(
      claude.credentialFrom(
        line({ type: 'system', subtype: 'init', apiKeySource: 'apiKeyHelper' }),
      ),
    ).toEqual({ billing: 'api-key', source: 'apiKeyHelper' })
    expect(codex.credentialFrom(line({ id: 2, result: { account: { type: 'apiKey' } } }))).toEqual({
      billing: 'api-key',
      source: 'apiKey',
    })
    expect(
      codex.credentialFrom(line({ id: 2, result: { account: { type: 'chatgpt', email: 'a' } } })),
    ).toEqual({ billing: 'subscription' })
  })

  test('Claude adds up total_cost_usd across agent restarts; Codex prices its tokens', () => {
    const result = (cost: number) => line({ type: 'result', total_cost_usd: cost })
    expect(claude.costOf([result(0.1), result(0.3), result(0.05)], undefined)).toBeCloseTo(0.35)
    expect(claude.costOf([], undefined)).toBeUndefined()
    const usage = line({
      method: 'thread/tokenUsage/updated',
      params: {
        tokenUsage: {
          total: { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 100_000 },
        },
      },
    })
    expect(codex.costOf([usage], 'gpt-5-mini')).toBeCloseTo(0.45)
  })

  test('under API key billing the key variables stay; under Subscription they go', () => {
    const env = { PATH: '/bin', ANTHROPIC_API_KEY: 'k', CODEX_API_KEY: 'c', OPENAI_API_KEY: 'o' }
    expect(claude.environment(env, 'subscription').ANTHROPIC_API_KEY).toBeUndefined()
    expect(claude.environment(env, 'api-key').ANTHROPIC_API_KEY).toBe('k')
    expect(codex.environment(env, 'subscription').CODEX_API_KEY).toBeUndefined()
    expect(codex.launch({ ...run, env, billing: 'api-key' }).env.CODEX_API_KEY).toBe('c')
  })

  test('an API key reaches the agent process but not the commands it runs; Subscription has no key to scrub', () => {
    const env = { PATH: '/bin', ANTHROPIC_API_KEY: 'k', CODEX_API_KEY: 'c' }
    const codexArgs = codex.launch({ ...run, env, billing: 'api-key' }).args
    expect(codexArgs).toContain(
      'shell_environment_policy.exclude=["CODEX_API_KEY","OPENAI_API_KEY"]',
    )
    const claudeLaunch = claude.launch({ ...run, env, billing: 'api-key' })
    expect(claudeLaunch.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1')
    expect(claude.launch({ ...run, env }).env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBeUndefined()
  })

  test('under Subscription TED removes what Claude Code’s scrub would, keeping what Claude signs in with', () => {
    const removed = {
      ANTHROPIC_API_KEY: 'k',
      ANTHROPIC_AUTH_TOKEN: 't',
      AWS_ACCESS_KEY_ID: 'AKIAABCDEFGHIJKLMNOP',
      AWS_SECRET_ACCESS_KEY: 's',
      AWS_SESSION_TOKEN: 's',
      GOOGLE_APPLICATION_CREDENTIALS: '/tmp/g.json',
      NPM_TOKEN: 'n',
      DB_PASSWORD: 'p',
      MY_PASSWD: 'p',
      MY_PASS: 'p',
      MY_SECRET: 's',
      OPENAI_API_KEY: 'o',
      MY_APIKEY: 'k',
      deploy_key: 'k',
      PRIVATE_KEY_PATH: '/tmp/k',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      DATABASE_URL: 'postgres://user:pw@db.example.com/app',
      SESSION: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
    }
    const kept = {
      PATH: '/bin',
      HOME: '/Users/me',
      PWD: '/work',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x',
      CLAUDE_CONFIG_DIR: '/Users/me/.claude-work',
      GITHUB_TOKEN: 'g',
      GH_TOKEN: 'g',
      GH_ENTERPRISE_TOKEN: 'g',
      GITHUB_ENTERPRISE_TOKEN: 'g',
      HTTPS_PROXY: 'http://u:p@proxy:8080',
      http_proxy: 'http://u:p@proxy:8080',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'url.file:///x/.insteadOf',
      GIT_CONFIG_VALUE_0: 'https://github.com/',
      TED_RUN_CAPABILITY: 'run-1.abc',
      KEYCHAIN_PATH: '/tmp/kc',
      TOKENIZERS_PARALLELISM: 'false',
      AUTHOR_NAME: 'a',
      AWS_PROFILE: 'dev',
      SITE_URL: 'https://example.com/x',
    }
    const launched = claude.launch({ ...run, env: { ...removed, ...kept } }).env
    for (const name of Object.keys(removed)) expect(launched[name], name).toBeUndefined()
    expect(launched).toMatchObject(kept)
    const apiKey = claude.launch({ ...run, env: { ...removed, ...kept }, billing: 'api-key' }).env
    expect(apiKey.AWS_SECRET_ACCESS_KEY).toBe('s')
    expect(apiKey.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1')
  })
})
