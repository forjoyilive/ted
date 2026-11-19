import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { antigravityPlanNotice } from '@ted/protocol'
import type { JsonObject } from '@ted/protocol/parse'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { parseStartSubAgentRequest } from '../../protocol/src/run-parsers.ts'
import { antigravityAgent } from '../src/agents/antigravity.ts'
import { type AntigravityPlan, drive } from '../src/agents/antigravity-driver.ts'
import { createAgents } from '../src/agents/index.ts'
import { piAgent } from '../src/agents/pi.ts'
import { drive as piDrive } from '../src/agents/pi-driver.ts'
import { piModels, piModelsReply } from '../src/agents/pi-models.ts'
import { resolveAgentChoices } from '../src/workflow/agent-choices.ts'
import { checkLayer } from '../src/workflow/check.ts'
import { stubPiPath } from './helpers.ts'

const home = mkdtempSync(path.join(tmpdir(), 'ted-agents-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))
const agents = createAgents({
  home,
  claudeBin: '/nowhere/claude',
  codexBin: '/nowhere/codex',
  platform: 'linux',
})
const macAgents = createAgents({
  home,
  claudeBin: '/nowhere/claude',
  codexBin: '/nowhere/codex',
  platform: 'darwin',
})
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
      expect.arrayContaining([
        'sandbox_mode="workspace-write"',
        'approval_policy="on-request"',
        'approvals_reviewer="auto_review"',
      ]),
    )
  })

  test.each([undefined, 'existing-session'])(
    'text-only launches stay restricted on resume %s',
    (resume) => {
      const claude = agents.get('claude').launch({
        ...run,
        tools: 'none',
        ...(resume !== undefined && { resume }),
        permissions: 'bypass',
      })
      expect(after(claude.args, '--tools')).toBe('')
      expect(claude.args).toContain('--strict-mcp-config')
      expect(after(claude.args, '--mcp-config')).toBe('{"mcpServers":{}}')
      expect(after(claude.args, '--setting-sources')).toBe('')
      expect(claude.args).toContain('--disable-slash-commands')
      expect(JSON.parse(claude.files['settings.json'] ?? '{}')).toEqual({ disableAllHooks: true })
      const codex = agents.get('codex').launch({
        ...run,
        tools: 'none',
        ...(resume !== undefined && { resume }),
        permissions: 'bypass',
      })
      expect(codex.args).toEqual(
        expect.arrayContaining([
          'sandbox_mode="read-only"',
          'approval_policy="never"',
          'features.shell_tool=false',
          'features.js_repl=false',
          'features.apps=false',
          'features.plugins=false',
          'features.multi_agent=false',
          'features.multi_agent_v2=false',
          'features.hooks=false',
          'features.codex_hooks=false',
          'web_search="disabled"',
          'notify=[]',
        ]),
      )
      expect(codex.args.join(' ')).not.toContain('danger-full-access')
      expect(codex.args.join(' ')).not.toContain('network_access=true')
      expect(JSON.parse(codex.input).textOnly).toBe(true)
    },
  )

  test('turn signals distinguish completed work from an idle thread', () => {
    const claude = agents.get('claude')
    const codex = agents.get('codex')
    expect(
      codex.turnFrom(
        JSON.stringify({ method: 'thread/status/changed', params: { status: { type: 'idle' } } }),
      ),
    ).toBeUndefined()
    expect(codex.turnFrom(JSON.stringify({ method: 'turn/started' }))).toBe('started')
    expect(codex.turnFrom(JSON.stringify({ method: 'turn/completed' }))).toBe('completed')
    expect(
      claude.turnFrom(
        JSON.stringify({
          type: 'user',
          message: { content: [{ type: 'text', text: 'Continue' }] },
        }),
      ),
    ).toBe('started')
    expect(
      claude.turnFrom(
        JSON.stringify({
          type: 'user',
          message: { content: [{ type: 'tool_result', content: 'Done' }] },
        }),
      ),
    ).toBeUndefined()
    expect(claude.turnFrom(JSON.stringify({ type: 'result' }))).toBe('completed')
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

  test('on macOS Claude Code’s own sandbox keeps shell commands out of the personal folders', () => {
    interface Settings {
      permissions?: { allow?: string[]; deny?: string[] }
      sandbox?: {
        enabled?: boolean
        autoAllowBashIfSandboxed?: boolean
        allowUnsandboxedCommands?: boolean
        filesystem?: { allowWrite?: string[]; denyRead?: string[] }
      }
      hooks?: { PreToolUse?: { matcher: string; hooks: { command: string }[] }[] }
    }
    const settings = (permissions: 'auto' | 'bypass'): Settings =>
      JSON.parse(
        macAgents.get('claude').launch({ ...run, permissions }).files['settings.json'] ?? '{}',
      )

    for (const permissions of ['auto', 'bypass'] as const) {
      const { sandbox, hooks } = settings(permissions)
      expect(sandbox).toMatchObject({
        enabled: true,
        autoAllowBashIfSandboxed: false,
        allowUnsandboxedCommands: true,
        filesystem: { allowWrite: ['/'] },
      })
      expect(sandbox?.filesystem?.denyRead).toEqual(
        expect.arrayContaining([
          '~/Desktop',
          '~/Documents',
          '~/Downloads',
          '~/Library/Mobile Documents',
        ]),
      )
      expect(settings(permissions).permissions?.deny).toContain('Read(~/Documents/**)')
      const guard = hooks?.PreToolUse?.find((entry) => entry.matcher === 'Bash')
      expect(guard?.hooks[0]?.command).toContain('claude-home-guard.ts')
    }
    expect(settings('auto').permissions?.allow).toEqual(['Bash(ted *)'])
    expect(settings('bypass').permissions?.allow).toBeUndefined()

    const textOnly = macAgents.get('claude').launch({ ...run, tools: 'none' })
    expect(JSON.parse(textOnly.files['settings.json'] ?? '{}')).toEqual({ disableAllHooks: true })
    const linux = JSON.parse(agents.get('claude').launch(run).files['settings.json'] ?? '{}')
    expect(linux.sandbox).toBeUndefined()
  })

  test('on macOS Codex under auto gets a permission profile that denies the personal folders', () => {
    const codex = macAgents.get('codex').launch(run).args
    expect(codex).toEqual(
      expect.arrayContaining([
        'default_permissions="ted"',
        'approval_policy="on-request"',
        'approvals_reviewer="auto_review"',
      ]),
    )
    const profile = codex.find((arg) => arg.startsWith('permissions='))
    expect(profile).toContain('extends=":workspace"')
    expect(profile).toContain('"~/Documents"="deny"')
    expect(profile).toContain('network={enabled=true}')
    expect(codex.join(' ')).not.toContain('sandbox_mode')

    const bypass = macAgents.get('codex').launch({ ...run, permissions: 'bypass' }).args
    expect(bypass).toContain('sandbox_mode="danger-full-access"')
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
    expect(resumed.env.CODEX_HOME).toBeUndefined()
    expect(fresh.env.CODEX_HOME).toBe(path.join(home, 'codex'))
    expect(resumed.args).not.toContain(`sqlite_home=${JSON.stringify(path.join(home, 'codex'))}`)
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

  test('Codex refuses linked session routing folders rather than resuming outside Ted storage', () => {
    const local = path.join(home, 'linked-home')
    mkdirSync(local)
    const codex = createAgents({ home: local }).get('codex')
    codex.environment({}, 'subscription')
    const folder = path.join(local, 'codex')
    const elsewhere = path.join(local, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(path.join(elsewhere, 'session'), '')
    symlinkSync(elsewhere, path.join(folder, 'ted-sessions'))
    expect(() => codex.launch({ ...run, resume: 'session' })).toThrow(/plain folder/)
  })

  test('Codex storage belongs to this Ted home regardless of inherited personal locations', () => {
    const codex = agents.get('codex')
    const env = { CODEX_HOME: '/personal/codex', CODEX_SQLITE_HOME: '/personal/db' }
    const launch = codex.launch({ ...run, env })
    const folder = path.join(home, 'codex')
    expect(launch.env).toMatchObject({ CODEX_HOME: folder, CODEX_SQLITE_HOME: folder })
    expect(launch.args).toContain(`sqlite_home=${JSON.stringify(folder)}`)
    const legacy = codex.launch({ ...run, env, resume: 'legacy-thread' })
    expect(legacy.env).toMatchObject(env)
    expect(legacy.args).not.toContain(`sqlite_home=${JSON.stringify(folder)}`)
    expect(codex.health.signIn(env)).toBe(
      `env CODEX_HOME='${folder}' CODEX_SQLITE_HOME='${folder}' codex login`,
    )
    const devHome = path.join(home, 'dev')
    mkdirSync(devHome)
    expect(
      createAgents({ home: devHome }).get('codex').environment(env, 'subscription').CODEX_HOME,
    ).toBe(path.join(devHome, 'codex'))
    expect(
      createAgents({ home: path.relative(process.cwd(), devHome) })
        .get('codex')
        .environment(env, 'subscription').CODEX_HOME,
    ).toBe(path.join(devHome, 'codex'))
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

  test('the Task Lead defaults to Claude Code, or Codex when only Codex is installed, or Pi when only Pi is', () => {
    const stub = process.execPath
    const none = { antigravityBin: '/nowhere/agy', piBin: '/nowhere/pi' }
    expect(createAgents({ ...none, claudeBin: stub, codexBin: stub }).defaultLead()).toBe('claude')
    expect(
      createAgents({ ...none, claudeBin: '/nowhere/claude', codexBin: stub }).defaultLead(),
    ).toBe('codex')
    expect(
      createAgents({ ...none, claudeBin: stub, codexBin: '/nowhere/codex' }).defaultLead(),
    ).toBe('claude')
    expect(
      createAgents({
        ...none,
        claudeBin: '/nowhere/claude',
        codexBin: '/nowhere/codex',
      }).defaultLead(),
    ).toBe('claude')
    expect(
      createAgents({
        ...none,
        claudeBin: '/nowhere/claude',
        codexBin: '/nowhere/codex',
        piBin: stub,
      }).defaultLead(),
    ).toBe('pi')
    expect(
      createAgents({
        ...none,
        claudeBin: stub,
        codexBin: '/nowhere/codex',
        piBin: stub,
      }).defaultLead(),
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
    expect(codex.costOf([usage], 'gpt-5')).toBeCloseTo(2.25)
    expect(codex.costOf([usage], 'gpt-5.3-codex')).toBeCloseTo(3.15)
    expect(codex.costOf([usage], 'gpt-6.1-sol')).toBeCloseTo(3)
    expect(codex.costOf([usage], 'gpt-6-sol-2026-10-01')).toBeCloseTo(3)
    expect(codex.costOf([usage], 'gpt-6-astra')).toBeCloseTo(15)
    expect(codex.costOf([usage], 'a-model-ted-has-no-price-for')).toBeCloseTo(3)
    const cached = line({
      method: 'thread/tokenUsage/updated',
      params: {
        tokenUsage: {
          total: { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 },
        },
      },
    })
    expect(codex.costOf([cached], 'gpt-6.1-sol')).toBeCloseTo(0.1)
    expect(codex.costOf([cached], 'gpt-5.5-pro')).toBeCloseTo(30)
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

  test('under Subscription Ted removes credentials from the Claude Run, including Claude’s and GitHub’s tokens', () => {
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
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x',
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'r',
      GITHUB_TOKEN: 'g',
      GH_TOKEN: 'g',
      GH_ENTERPRISE_TOKEN: 'g',
      GITHUB_ENTERPRISE_TOKEN: 'g',
    }
    const kept = {
      PATH: '/bin',
      HOME: '/Users/me',
      PWD: '/work',
      CLAUDE_CONFIG_DIR: '/Users/me/.claude-work',
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
    expect(claude.environment({ ...removed, ...kept }, 'subscription')).toEqual(launched)
    const apiKey = claude.launch({ ...run, env: { ...removed, ...kept }, billing: 'api-key' }).env
    expect(apiKey).toMatchObject({ ...kept, ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't' })
    expect(apiKey.GH_TOKEN).toBeUndefined()
    expect(apiKey.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(apiKey.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1')
  })

  test('Codex’s process holds no credentials but its own key under API key billing, so a restart can’t bring them back', () => {
    const removed = {
      NPM_TOKEN: 'n',
      GH_TOKEN: 'g',
      AWS_SECRET_ACCESS_KEY: 's',
      DATABASE_URL: 'postgres://user:pw@db.example.com/app',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
    }
    const kept = {
      PATH: '/bin',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'url.file:///x/.insteadOf',
      HTTPS_PROXY: 'http://u:p@proxy:8080',
      TED_RUN_CAPABILITY: 'run-1.abc',
    }
    const keys = { CODEX_API_KEY: 'c', OPENAI_API_KEY: 'o' }
    const env = { ...removed, ...kept, ...keys }
    const subscription = codex.launch({ ...run, env }).env
    const privateEnv = {
      CODEX_HOME: path.join(home, 'codex'),
      CODEX_SQLITE_HOME: path.join(home, 'codex'),
    }
    expect(subscription).toEqual({ ...kept, ...privateEnv })
    expect(codex.environment(env, 'subscription')).toEqual({ ...kept, ...privateEnv })
    const apiKey = codex.launch({ ...run, env, billing: 'api-key' })
    expect(apiKey.env).toEqual({ ...kept, ...keys, ...privateEnv })
    expect(apiKey.args).toEqual(codex.launch({ ...run, env: {}, billing: 'api-key' }).args)
  })
})

function antigravityHarness(
  fields: Partial<AntigravityPlan> = {},
  overrides: Record<string, unknown> = {},
) {
  const sent: {
    id?: number | string
    method?: string
    params?: Record<string, unknown>
    result?: unknown
  }[] = []
  const events: string[] = []
  const stop = vi.fn()
  const configOptions = [
    { id: 'model', category: 'model', options: [{ value: 'gemini-test', name: 'Test model' }] },
    {
      id: 'thinking',
      category: 'thought_level',
      options: [
        { value: 'extra', name: 'Extra' },
        { value: 'max', name: 'Max' },
      ],
    },
  ]
  const driver = drive({
    cwd: '/task-worktree',
    input: JSON.stringify({
      prompt: 'Start',
      billing: 'subscription',
      clientVersion: 'test',
      ...fields,
    }),
    stop,
    emit: (line) => events.push(line),
    send(line) {
      const message = JSON.parse(line)
      sent.push(message)
      if (!message.method || message.id === undefined || message.method === 'session/prompt') return
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: 1,
              agentCapabilities: { sessionCapabilities: { resume: {} } },
              authMethods: [{ id: 'oauth-personal' }, { id: 'gemini-api-key' }],
            }
          : message.method === 'session/new'
            ? {
                sessionId: 'session',
                configOptions,
                models: { availableModels: [{ modelId: 'gemini-test-max' }] },
              }
            : message.method === 'session/resume' || message.method === 'session/set_config_option'
              ? { configOptions }
              : {}
      queueMicrotask(() =>
        driver.onLine(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            ...((overrides[message.method] ?? { result }) as object),
          }),
        ),
      )
    },
  })
  const update = (update: unknown) =>
    driver.onLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'session', update },
      }),
    )
  const complete = () => {
    for (const message of sent.filter((m) => m.method === 'session/prompt'))
      driver.onLine(
        JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } }),
      )
  }
  return { driver, sent, events, stop, update, complete }
}

test.each([undefined, 'session'])(
  'Antigravity uses the launched workspace for ACP: %s',
  async (resume) => {
    const h = antigravityHarness({ prompt: '', ...(resume && { resume }) })
    const method = resume ? 'session/resume' : 'session/new'
    await vi.waitFor(() => expect(h.sent.some((message) => message.method === method)).toBe(true))
    expect(h.sent.find((message) => message.method === method)?.params?.cwd).toBe('/task-worktree')
    expect(process.cwd()).not.toBe('/task-worktree')
  },
)

test('Antigravity refuses a strict tool-free launch rather than weakening its contract', () => {
  expect(() => antigravityAgent('/nowhere/agy').launch({ ...run, tools: 'none' })).toThrow(
    'cannot guarantee tool-free',
  )
})

describe('Antigravity', () => {
  const agent = antigravityAgent('/nowhere/agy')

  test('launches ACP with explicit permission and billing choices, without leaking other credentials', () => {
    const env = {
      PATH: '/bin',
      GEMINI_API_KEY: 'gemini-key',
      GOOGLE_API_KEY: 'other-key',
      AGY_ADC_AUTH: 'true',
      GOOGLE_APPLICATION_CREDENTIALS: '/credentials',
      GOOGLE_GEMINI_BASE_URL: 'https://unexpected.invalid',
      GH_TOKEN: 'secret',
      TED_RUN_CAPABILITY: 'run-1.abc',
    }
    const subscription = agent.launch({ ...run, env })
    expect(subscription.args).toEqual(['acp', '--disable-telemetry', '--sandbox'])
    expect(subscription.env).toEqual({ PATH: '/bin', TED_RUN_CAPABILITY: 'run-1.abc' })
    expect(JSON.parse(subscription.input)).toMatchObject({ billing: 'subscription' })
    const api = agent.launch({
      ...run,
      env,
      billing: 'api-key',
      permissions: 'bypass',
      resume: 'session',
    })
    expect(api.args).toContain('--dangerously-skip-permissions')
    expect(api.env).toEqual({
      PATH: '/bin',
      TED_RUN_CAPABILITY: 'run-1.abc',
      GEMINI_API_KEY: 'gemini-key',
    })
    expect(api.input).not.toContain('gemini-key')
    expect(api.sessionId).toBe('session')
    expect(() => agent.launch({ ...run, billing: 'api-key' })).toThrow('GEMINI_API_KEY')
    expect(() => agent.launch({ ...run, model: '--unsafe' })).toThrow('model name')
  })

  test('accepts Antigravity at the public sub-agent parser and each workflow role', () => {
    expect(
      parseStartSubAgentRequest({
        prompt: 'Review',
        agent: 'antigravity',
        model: 'gemini-test',
        effort: 'high',
      }),
    ).toMatchObject({ agent: 'antigravity', model: 'gemini-test', effort: 'high' })
    const layer = checkLayer({
      kind: 'factory',
      files: {
        'workflow.yaml': 'lead: antigravity\nreviewer: antigravity\nplanner: antigravity\n',
      },
    })
    expect(layer.problems.filter((p) => p.severity === 'error')).toEqual([])
    const choices = resolveAgentChoices(layer.settings, {
      claude: true,
      codex: true,
      antigravity: true,
    })
    for (const role of ['lead', 'reviewer', 'planner'] as const)
      expect(choices[role].agent).toBe('antigravity')
    expect(
      resolveAgentChoices(undefined, { claude: true, codex: true, antigravity: true }).lead.agent,
    ).toBe('claude')
  })

  test('selects subscription authentication, configures advertised options and recovers the session without replay', async () => {
    const h = antigravityHarness({ resume: 'session', model: 'gemini-test', effort: 'xhigh' })
    await vi.waitFor(() => expect(h.sent.some((m) => m.method === 'session/prompt')).toBe(true))
    expect(h.sent.find((m) => m.method === 'initialize')?.params).toMatchObject({
      clientInfo: { name: 'ted' },
      clientCapabilities: {},
    })
    expect(h.sent.find((m) => m.method === 'authenticate')?.params).toEqual({
      methodId: 'oauth-personal',
    })
    expect(h.sent.find((m) => m.method === 'session/resume')?.params).toMatchObject({
      sessionId: 'session',
      cwd: '/task-worktree',
      mcpServers: [],
    })
    expect(
      h.sent.filter((m) => m.method === 'session/set_config_option').map((m) => m.params?.value),
    ).toEqual(['gemini-test', 'extra'])
    expect(h.events.some((line) => agent.sessionIdFrom(line) === 'session')).toBe(true)
    h.complete()
    await vi.waitFor(() => expect(h.events.at(-1)).toContain('idle'))
    expect(h.stop).not.toHaveBeenCalled()
  })

  test('streams chat, tools and file diffs, steers at Ted’s request, and queues ordinary follow-ups', async () => {
    const h = antigravityHarness({ billing: 'api-key' })
    await vi.waitFor(() =>
      expect(h.sent.filter((m) => m.method === 'session/prompt')).toHaveLength(1),
    )
    expect(h.sent.find((m) => m.method === 'authenticate')?.params).toEqual({
      methodId: 'gemini-api-key',
    })
    h.update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Editing now.' },
    })
    h.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'edit',
      title: 'Edit app.ts',
      kind: 'edit',
      status: 'in_progress',
    })
    h.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'edit',
      status: 'completed',
      content: [{ type: 'diff', path: '/repo/app.ts', oldText: 'old\n', newText: 'new\n' }],
    })
    const chat = agent.chat(
      h.events.map((line, offset) => ({ line, offset })),
      '/repo',
    )
    expect(chat).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'agent', text: 'Editing now.' }),
        expect.objectContaining({
          kind: 'tool',
          status: 'done',
          diffs: [expect.objectContaining({ path: 'app.ts', additions: 1, deletions: 1 })],
        }),
      ]),
    )
    expect(h.events.some(agent.boundaryFrom)).toBe(true)
    h.driver.onInput?.(agent.message('Wait for this turn'))
    expect(h.sent.filter((m) => m.method === 'session/prompt')).toHaveLength(1)
    h.driver.onInput?.(agent.steer('Use the new requirement'))
    expect(h.sent.filter((m) => m.method === 'session/prompt')).toHaveLength(2)
    h.complete()
    await vi.waitFor(() =>
      expect(h.sent.filter((m) => m.method === 'session/prompt')).toHaveLength(3),
    )
    h.complete()
    await vi.waitFor(() => expect(h.events.at(-1)).toContain('idle'))
  })

  test.each([true, false])(
    'permission approval %s grants only one operation and cancel abandons pending requests',
    async (approved) => {
      const h = antigravityHarness()
      await vi.waitFor(() => expect(h.sent.some((m) => m.method === 'session/prompt')).toBe(true))
      const ask = (id: number) =>
        h.driver.onLine(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'session/request_permission',
            params: {
              sessionId: 'session',
              toolCall: { title: 'git status', rawInput: { command: 'git status' } },
              options: [
                { optionId: 'once', kind: 'allow_once' },
                { optionId: 'always', kind: 'allow_always' },
                { optionId: 'no', kind: 'reject_once' },
              ],
            },
          }),
        )
      ask(900)
      const permission = agent.permissionPromptFrom(h.events.at(-1) ?? '', () => undefined)
      expect(permission).toMatchObject({ requestId: '900', command: 'git status', refuse: false })
      expect(permission?.details).toContain('git status')
      for (const line of agent.permissionReply({ requestId: '900', approved }))
        h.driver.onInput?.(line)
      expect(h.sent.find((m) => m.id === 900)?.result).toEqual({
        outcome: { outcome: 'selected', optionId: approved ? 'once' : 'no' },
      })
      ask(901)
      h.driver.onInput?.(agent.interrupt()[0] ?? '')
      expect(h.sent.find((m) => m.id === 901)?.result).toEqual({
        outcome: { outcome: 'cancelled' },
      })
      expect(h.sent.some((m) => m.method === 'session/cancel')).toBe(true)
      h.complete()
      await vi.waitFor(() => expect(h.events.at(-1)).toContain('idle'))
    },
  )

  test.each([
    { initialize: { result: { protocolVersion: 2 } } },
    { authenticate: { error: { code: -32000, message: 'Authentication required' } } },
    { 'session/new': { error: { code: -1, message: 'session unavailable' } } },
  ])('refuses an unsupported or failed handshake: %j', async (overrides) => {
    const h = antigravityHarness({}, overrides)
    await vi.waitFor(() => expect(h.stop).toHaveBeenCalledOnce())
    expect(h.sent.some((m) => m.method === 'session/prompt')).toBe(false)
    expect(h.events.some((line) => JSON.parse(line).ted_antigravity === 'error')).toBe(true)
  })

  test('fails closed for missing resume support and never falls back to a new conversation', async () => {
    const h = antigravityHarness(
      { resume: 'session' },
      {
        initialize: {
          result: {
            protocolVersion: 1,
            agentCapabilities: {},
            authMethods: [{ id: 'oauth-personal' }],
          },
        },
      },
    )
    await vi.waitFor(() => expect(h.stop).toHaveBeenCalledOnce())
    expect(h.sent.some((m) => m.method === 'session/new')).toBe(false)
  })

  test('unknown server tools are rejected and malformed output stops the driver', async () => {
    const h = antigravityHarness({ prompt: '' })
    await vi.waitFor(() => expect(h.events.some((line) => agent.sessionIdFrom(line))).toBe(true))
    h.driver.onLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 901,
        method: 'fs/write_text_file',
        params: { path: '/outside', content: 'no' },
      }),
    )
    expect(h.sent.find((m) => m.id === 901)).toMatchObject({ error: { code: -32601 } })
    h.driver.onLine('not json')
    expect(h.stop).toHaveBeenCalledOnce()
  })
})

test('Antigravity health checks capability and the non-secret sign-in marker without creating sessions', async () => {
  const agent = antigravityAgent(
    fileURLToPath(new URL('./fixtures/stub-antigravity.ts', import.meta.url)),
  )
  const inspect = agent.health.inspect
  if (!inspect) throw new Error('Missing health inspection')
  const home = await mkdtemp(path.join(tmpdir(), 'ted-agy-health-'))
  try {
    const base = {
      binary: agent.binary,
      env: { ...process.env, HOME: home },
      cwd: home,
      planAccepted: true,
    }
    await expect(inspect({ ...base, billing: 'subscription' })).resolves.toEqual({
      signedIn: false,
    })
    await expect(
      inspect({ ...base, billing: 'subscription', planAccepted: false }),
    ).resolves.toEqual({ signedIn: false, problem: { reason: antigravityPlanNotice } })
    await expect(
      inspect({
        ...base,
        env: { ...base.env, GEMINI_API_KEY: 'stub-key' },
        billing: 'api-key',
        planAccepted: false,
      }),
    ).resolves.toMatchObject({ signedIn: true, billing: 'api-key' })
    const cache = path.join(home, '.gemini', 'antigravity-cli', 'cache')
    await mkdir(cache, { recursive: true })
    await writeFile(
      path.join(cache, 'acp-auth-state.json'),
      JSON.stringify({ methodId: 'oauth-personal' }),
    )
    await expect(inspect({ ...base, billing: 'subscription' })).resolves.toMatchObject({
      signedIn: true,
      billing: 'subscription',
    })
    await expect(
      inspect({ ...base, env: { ...base.env, GEMINI_API_KEY: '' }, billing: 'api-key' }),
    ).resolves.toMatchObject({
      signedIn: false,
      problem: { reason: expect.stringContaining('GEMINI_API_KEY') },
    })
    await expect(
      inspect({ ...base, env: { ...base.env, GEMINI_API_KEY: 'stub-key' }, billing: 'api-key' }),
    ).resolves.toMatchObject({ signedIn: true, billing: 'api-key' })
    await writeFile(
      path.join(cache, 'acp-auth-state.json'),
      JSON.stringify({ methodId: 'gemini-api-key' }),
    )
    await expect(inspect({ ...base, billing: 'subscription' })).resolves.toEqual({
      signedIn: false,
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Antigravity accepts advertised model slugs with an effort suffix', async () => {
  const h = antigravityHarness({ model: 'gemini-test-max' })
  await vi.waitFor(() => expect(h.sent.some((m) => m.method === 'session/prompt')).toBe(true))
  expect(
    h.sent.filter((m) => m.method === 'session/set_config_option').map((m) => m.params?.value),
  ).toEqual(['gemini-test', 'max'])
  h.complete()
  await vi.waitFor(() => expect(h.events.at(-1)).toContain('idle'))
})

test.each([undefined, 'session'])(
  'Antigravity isolates chat Runs on new and resumed sessions: %s',
  (resume) => {
    const agent = antigravityAgent('/nowhere/agy')
    const launch = agent.launch({
      ...run,
      tools: 'isolated',
      permissions: 'bypass',
      ...(resume !== undefined && { resume }),
    })
    expect(launch.args).not.toContain('--dangerously-skip-permissions')
    expect(launch.args).toEqual(
      expect.arrayContaining([
        '--sandbox',
        '--include-default-customizations=false',
        '--agent',
        'ted-text-only',
      ]),
    )
    expect(launch.cwd).toBe('/tmp/run/antigravity-text-only')
    expect(JSON.parse(launch.input)).toMatchObject({ isolated: true })
    const settings = JSON.parse(
      launch.files['antigravity-isolated/antigravity-cli/settings.json'] ?? '{}',
    )
    expect(settings).toMatchObject({
      toolPermission: 'strict',
      allowNonWorkspaceAccess: false,
      permissions: {
        allow: [],
        ask: [],
        deny: expect.arrayContaining([
          'command(*)',
          'read_file(*)',
          'write_file(*)',
          'read_url(*)',
          'execute_url(*)',
          'mcp(*)',
        ]),
      },
    })
    expect(launch.files['antigravity-isolated/config/hooks.json']).toBe('{}')
    expect(launch.files['antigravity-isolated/config/mcp_config.json']).toBe('{"mcpServers":{}}')
    expect(launch.files['antigravity-text-only/.agents/agents/ted-text-only.md']).toContain(
      'tools: []',
    )
    for (const profile of [
      'antigravity-text-only/.agents/agents/ted-text-only.md',
      'antigravity-isolated/config/agents/ted-text-only.md',
    ]) {
      expect(launch.files[profile]).toContain('excludeDefaultComponents: true')
      expect(launch.files[profile]).toContain('inheritCustomizations: false')
    }
    expect(launch.files['antigravity-text-only/.git/HEAD']).toBeTruthy()
  },
)

test('Antigravity cancels every tool permission in a tool-free Run and stops on tool activity', async () => {
  const h = antigravityHarness({ textOnly: true })
  await vi.waitFor(() => expect(h.sent.some((m) => m.method === 'session/prompt')).toBe(true))
  h.driver.onLine(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'forbidden',
      method: 'session/request_permission',
      params: {
        sessionId: 'session',
        toolCall: { title: 'Read files', rawInput: { path: '/outside' } },
        options: [{ optionId: 'allow', kind: 'allow_once' }],
      },
    }),
  )
  expect(h.sent.find((m) => m.id === 'forbidden')?.result).toEqual({
    outcome: { outcome: 'cancelled' },
  })
  expect(h.events.some((line) => JSON.parse(line).ted_antigravity === 'permission')).toBe(false)
  h.update({ sessionUpdate: 'tool_call', toolCallId: 'unexpected', title: 'Read', kind: 'read' })
  expect(h.stop).toHaveBeenCalledOnce()
  h.complete()
})

test.each([undefined, 'session'])(
  'Antigravity isolated chats retain tool activity and cancel permissions: %s',
  async (resume) => {
    const h = antigravityHarness({ isolated: true, ...(resume && { resume }) })
    await vi.waitFor(() => expect(h.sent.some((m) => m.method === 'session/prompt')).toBe(true))
    h.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'list',
      title: 'manage_task',
      kind: 'other',
    })
    h.update({ sessionUpdate: 'tool_call_update', toolCallId: 'list', status: 'completed' })
    expect(h.stop).not.toHaveBeenCalled()
    h.driver.onLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'denied',
        method: 'session/request_permission',
        params: { sessionId: 'session', options: [{ optionId: 'allow', kind: 'allow_once' }] },
      }),
    )
    expect(h.sent.find((message) => message.id === 'denied')?.result).toEqual({
      outcome: { outcome: 'cancelled' },
    })
    expect(h.events.some((line) => JSON.parse(line).ted_antigravity === 'permission')).toBe(false)
    h.complete()
    await vi.waitFor(() => expect(h.events.at(-1)).toContain('idle'))
    expect(
      antigravityAgent('/nowhere/agy').chat(
        h.events.map((line, offset) => ({ line, offset })),
        '/task-worktree',
      ),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'tool', status: 'done' })]))
  },
)

const realAntigravity = process.env.TED_REAL_ANTIGRAVITY_BIN

test.skipIf(!realAntigravity).each([false, true])(
  'native Antigravity isolated chat limits declared tools and completes tool use or refusal (recovered: %s)',
  async (recover) => {
    if (!realAntigravity) throw new Error('Missing native CLI path')
    const root = await mkdtemp(path.join(tmpdir(), 'ted-agy-text-only-'))
    const marker = path.join(root, 'hook-ran')
    const requests: { url: string; body: Record<string, unknown>; generation: boolean }[] = []
    const generations = () => requests.filter((request) => request.generation)
    function declaredTools(request: (typeof requests)[number]) {
      const groups = request.body.tools ?? []
      expect(Array.isArray(groups), JSON.stringify(request)).toBe(true)
      const tools = groups as {
        functionDeclarations: {
          name: string
          parametersJsonSchema: { properties: { Action: { enum: string[] } } }
        }[]
      }[]
      for (const group of tools) {
        expect(Object.keys(group), JSON.stringify(request)).toEqual(['functionDeclarations'])
        expect(Array.isArray(group.functionDeclarations), JSON.stringify(request)).toBe(true)
      }
      const functions = tools.flatMap((group) => group.functionDeclarations)
      expect(functions.length, JSON.stringify(request)).toBeLessThanOrEqual(1)
      for (const fn of functions) {
        expect(fn.name, JSON.stringify(request)).toBe('manage_task')
        expect(fn.parametersJsonSchema.properties.Action.enum.toSorted()).toEqual([
          'kill',
          'list',
          'send_input',
          'status',
        ])
      }
      return functions
    }
    let injectTool = false
    let injected: (typeof requests)[number] | undefined
    const server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      const url = request.url ?? ''
      const generation = /:(?:streamGenerateContent|generateContent)(?:\?|$)/.test(url)
      const captured: (typeof requests)[number] = {
        url,
        body: body ? (JSON.parse(body) as Record<string, unknown>) : {},
        generation,
      }
      requests.push(captured)
      if (!generation) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(url.includes('countTokens') ? { totalTokens: 1 } : {}))
        return
      }
      const inject =
        injectTool &&
        !injected &&
        (JSON.stringify(captured.body.contents) ?? '').includes(
          'Reply using supplied context only.',
        )
      const result = {
        candidates: [
          {
            content: {
              role: 'model',
              parts: inject
                ? [{ functionCall: { name: 'manage_task', args: { Action: 'list' } } }]
                : [{ text: 'Supplied context only.' }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      }
      if (inject) injected = captured
      const streaming = request.url?.includes('streamGenerateContent')
      response.writeHead(200, {
        'content-type': streaming ? 'text/event-stream' : 'application/json',
      })
      response.end(streaming ? `data: ${JSON.stringify(result)}\n\n` : JSON.stringify(result))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing model endpoint')
    const port = address.port
    const runDir = path.join(root, 'runs', 'chat')
    let child: ReturnType<typeof spawn> | undefined
    let closed: Promise<unknown> | undefined
    try {
      const hooks = JSON.stringify({
        unexpected: { SessionStart: [{ type: 'command', command: `touch '${marker}'` }] },
      })
      for (const folder of [path.join(root, '.gemini', 'config'), path.join(root, '.agents')]) {
        await mkdir(folder, { recursive: true })
        await writeFile(path.join(folder, 'hooks.json'), hooks)
      }
      const agent = antigravityAgent(realAntigravity)
      const launch = agent.launch({
        prompt: 'Explain only the supplied context. Reply briefly.',
        runDir,
        env: { ...process.env, HOME: root, GEMINI_API_KEY: 'local-fixture-only' },
        billing: 'api-key',
        permissions: 'bypass',
        tools: 'isolated',
      })
      for (const [name, content] of Object.entries(launch.files)) {
        const file = path.join(runDir, name)
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, content)
      }
      function connect(resume?: string) {
        // The native CLI talks only to this fixture; no Google key or model endpoint is used.
        const running = spawn(launch.command, launch.args, {
          cwd: launch.cwd ?? runDir,
          env: { ...launch.env, GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${port}` },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        child = running
        closed = once(running, 'close')
        const events: string[] = []
        running.stdin?.on('error', () => {})
        running.stderr?.resume()
        const driver = drive({
          cwd: launch.cwd ?? runDir,
          input:
            resume === undefined
              ? launch.input
              : JSON.stringify({ ...JSON.parse(launch.input), resume }),
          send: (line) => running.stdin?.write(`${line}\n`),
          emit: (line) => events.push(line),
          stop: () => {
            running.kill('SIGTERM')
          },
        })
        if (!running.stdout) throw new Error('Missing native CLI output')
        const lines = createInterface({ input: running.stdout })
        lines.on('line', (line) => driver.onLine(line))
        return { events, driver, lines }
      }
      let connected = connect()
      if (recover) {
        await vi.waitFor(
          () => {
            const failure = connected.events.find(
              (line) => JSON.parse(line).ted_antigravity === 'error',
            )
            if (failure) throw new Error(failure)
            expect(
              connected.events.some((line) => JSON.parse(line).ted_antigravity === 'completed'),
            ).toBe(true)
          },
          { timeout: 30_000, interval: 50 },
        )
        const session = connected.events
          .map((line) => JSON.parse(line))
          .find((event) => event.sessionId)
        expect(session?.sessionId).toBeTruthy()
        connected.lines.close()
        child?.kill('SIGTERM')
        await closed
        connected = connect(session.sessionId)
      }
      const { events, driver, lines } = connected
      await vi.waitFor(
        () => {
          const failure = events.find((line) => JSON.parse(line).ted_antigravity === 'error')
          if (failure) throw new Error(failure)
          expect(events.some((line) => JSON.parse(line).ted_antigravity === 'completed')).toBe(true)
        },
        { timeout: 30_000, interval: 50 },
      )
      expect(generations().length, JSON.stringify(requests)).toBeGreaterThan(0)
      for (const request of generations()) declaredTools(request)
      expect(events.some((line) => JSON.parse(line).update?.sessionUpdate === 'tool_call')).toBe(
        false,
      )
      await expect(access(marker)).rejects.toThrow()
      expect(
        agent.chat(
          events.map((line, offset) => ({ line, offset })),
          launch.cwd ?? runDir,
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'agent',
            text: expect.stringContaining('Supplied context only.'),
          }),
        ]),
      )
      injectTool = true
      const beforeInjection = requests.length
      const beforeEvents = events.length
      driver.onInput?.(JSON.stringify({ text: 'Reply using supplied context only.' }))
      await vi.waitFor(
        () => {
          const turn = events.slice(beforeEvents).map((line) => JSON.parse(line))
          expect(turn.find((event) => event.ted_antigravity === 'error')).toBeUndefined()
          expect(turn.some((event) => event.ted_antigravity === 'completed')).toBe(true)
        },
        { timeout: 30_000, interval: 50 },
      )
      expect(injected, JSON.stringify(requests)).toBeDefined()
      if (!injected) throw new Error('The supplied prompt never reached the native model fixture')
      const afterInjection = JSON.stringify(requests.slice(beforeInjection))
      expect(afterInjection).toContain('functionResponse')
      expect(afterInjection).toContain('manage_task')
      const turn = events.slice(beforeEvents)
      declaredTools(injected)
      if (!/unknown tool.*manage_task/is.test(afterInjection)) {
        expect(afterInjection).not.toMatch(/unknown tool/i)
        expect(turn.some((line) => JSON.parse(line).update?.sessionUpdate === 'tool_call')).toBe(
          true,
        )
        expect(
          agent.chat(
            turn.map((line, offset) => ({ line, offset })),
            launch.cwd ?? runDir,
          ),
        ).toEqual(
          expect.arrayContaining([expect.objectContaining({ kind: 'tool', status: 'done' })]),
        )
      } else {
        expect(afterInjection).toMatch(/unknown tool.*manage_task/is)
      }
      expect(
        agent.chat(
          turn.map((line, offset) => ({ line, offset })),
          launch.cwd ?? runDir,
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'agent',
            done: true,
            text: expect.stringContaining('Supplied context only.'),
          }),
        ]),
      )
      for (const request of generations()) declaredTools(request)
      await expect(access(marker)).rejects.toThrow()
      lines.close()
    } finally {
      child?.kill('SIGTERM')
      if (closed)
        await Promise.race([
          closed,
          new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              child?.kill('SIGKILL')
              resolve()
            }, 2_000)
            timer.unref()
          }),
        ])
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  },
  105_000,
)

describe('Pi', () => {
  const agent = piAgent('/nowhere/pi')
  const bypass = { ...run, permissions: 'bypass' as const }

  test('launches RPC mode with its sessions in the Run folder, the model, and the effort as thinking', () => {
    const launch = agent.launch({ ...bypass, model: 'ollama/gemma4:12b', effort: 'ultra' })
    expect(launch.args).toEqual([
      '--mode',
      'rpc',
      '--approve',
      '--session-dir',
      '/tmp/run/pi-sessions',
      '--model',
      'ollama/gemma4:12b',
      '--thinking',
      'max',
    ])
    expect(launch.lines).toBe('lf')
    expect(launch.driver).toMatch(/pi-driver\.ts$/)
    expect(JSON.parse(launch.input)).toEqual({ prompt: 'Carry on' })
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const)
      expect(after(agent.launch({ ...bypass, effort }).args, '--thinking')).toBe(effort)
    expect(agent.launch(bypass).args).not.toContain('--model')
    expect(() => agent.launch({ ...bypass, model: '--unsafe' })).toThrow('model name')
  })

  test('a tool-free chat starts Pi without tools, MCP, extensions, skills or the repo’s files', () => {
    const args = agent.launch({ ...run, tools: 'none' }).args
    expect(args).toEqual(
      expect.arrayContaining(['--no-tools', '--no-mcp', '--no-extensions', '--no-skills']),
    )
    expect(args).toContain('--no-approve')
    expect(args).not.toContain('--approve')
  })

  test('starts with tools outside Bypass, where the Run host wraps it in Ted’s sandbox', () => {
    expect(agent.launch(run).args).toContain('--approve')
    expect(() => agent.launch({ ...run, tools: 'none' })).not.toThrow()
  })

  test('keeps Pi’s own settings folder but not credential variables', () => {
    const { env } = agent.launch({
      ...bypass,
      env: { PATH: '/bin', PI_CODING_AGENT_DIR: '/pi', OPENAI_API_KEY: 'sk-test' },
    })
    expect(env).toEqual({ PATH: '/bin', PI_CODING_AGENT_DIR: '/pi' })
  })

  test('resumes by the session file Pi saved in the Run folder, and refuses when it is missing', () => {
    const runDir = mkdtempSync(path.join(tmpdir(), 'ted-pi-run-'))
    try {
      mkdirSync(path.join(runDir, 'pi-sessions'))
      const file = path.join(runDir, 'pi-sessions', '2026-11-18T00-00-00-000Z_abc-123.jsonl')
      writeFileSync(file, '{}\n')
      const resumed = agent.launch({ ...bypass, runDir, prompt: '', resume: 'abc-123' })
      expect(after(resumed.args, '--session')).toBe(file)
      expect(resumed.sessionId).toBe('abc-123')
      expect(() => agent.launch({ ...bypass, runDir, resume: 'gone' })).toThrow(
        'Pi’s saved session gone is missing from this Run’s folder',
      )
      expect(() => agent.launch({ ...bypass, runDir, resume: '../elsewhere' })).toThrow('session')
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  function piHarness(prompt = 'Start') {
    const sent: { id?: string; type?: string; message?: string; streamingBehavior?: string }[] = []
    const events: string[] = []
    const failures: string[] = []
    const driver = piDrive({
      input: JSON.stringify({ prompt }),
      cwd: '/w',
      stop: () => {},
      fail: (message) => failures.push(message),
      emit: (line) => events.push(line),
      send: (line) => sent.push(JSON.parse(line)),
    })
    const pi = (line: string) => driver.onLine(line)
    const ready = () =>
      pi(
        JSON.stringify({
          type: 'response',
          id: 'ted-state',
          command: 'get_state',
          success: true,
          data: { sessionId: 'session-1', sessionFile: '/w/s.jsonl' },
        }),
      )
    const kinds = () => events.map((line) => JSON.parse(line).ted_pi)
    return { driver, sent, events, failures, pi, ready, kinds }
  }

  test('the driver records the session, steers while Pi works, and starts a new turn once Pi settles', () => {
    const h = piHarness()
    expect(h.sent).toEqual([{ id: 'ted-state', type: 'get_state' }])
    h.ready()
    expect(h.events.some((line) => agent.sessionIdFrom(line) === 'session-1')).toBe(true)
    expect(h.sent.at(-1)).toMatchObject({ type: 'prompt', message: 'Start' })
    expect(h.sent.at(-1)?.streamingBehavior).toBeUndefined()
    expect(h.events.map((line) => agent.turnFrom(line)).filter(Boolean)).toEqual(['started'])

    h.driver.onInput?.(agent.message('Also this'))
    h.driver.onInput?.(agent.steer('Now this'))
    expect(h.sent.slice(-2)).toMatchObject([
      { type: 'prompt', message: 'Also this', streamingBehavior: 'steer' },
      { type: 'prompt', message: 'Now this', streamingBehavior: 'steer' },
    ])
    expect(h.events.map((line) => agent.acceptedTextFrom(line)).filter(Boolean)).toEqual([
      'Start',
      'Also this',
      'Now this',
    ])
    expect(h.events.map((line) => agent.turnFrom(line)).filter(Boolean)).toEqual(['started'])

    h.pi(JSON.stringify({ type: 'agent_settled', aborted: false }))
    expect(agent.stateFrom(h.events.at(-1) ?? '')).toBe('idle')
    expect(agent.turnFrom(h.events.at(-1) ?? '')).toBe('completed')
    h.driver.onInput?.(agent.message('Next'))
    expect(h.sent.at(-1)).toMatchObject({ type: 'prompt', message: 'Next' })
    expect(h.sent.at(-1)?.streamingBehavior).toBeUndefined()
  })

  test('the driver cancels extension dialogs and ignores notifications', () => {
    const h = piHarness()
    h.ready()
    for (const method of ['select', 'confirm', 'input', 'editor'])
      h.pi(
        JSON.stringify({ type: 'extension_ui_request', id: `d-${method}`, method, title: 'Ask' }),
      )
    h.pi(
      JSON.stringify({ type: 'extension_ui_request', id: 'n-1', method: 'notify', message: 'Hi' }),
    )
    expect(h.sent.filter((c) => c.type === 'extension_ui_response')).toEqual([
      { type: 'extension_ui_response', id: 'd-select', cancelled: true },
      { type: 'extension_ui_response', id: 'd-confirm', cancelled: true },
      { type: 'extension_ui_response', id: 'd-input', cancelled: true },
      { type: 'extension_ui_response', id: 'd-editor', cancelled: true },
    ])
  })

  test('stopping clears Pi’s queue and aborts; text sent meanwhile waits for the next turn', () => {
    const h = piHarness()
    h.ready()
    h.driver.onInput?.(agent.interrupt()[0] ?? '')
    expect(h.sent.slice(-2).map((c) => c.type)).toEqual(['clear_queue', 'abort'])
    h.driver.onInput?.(agent.message('After the stop'))
    expect(h.sent.some((c) => c.message === 'After the stop')).toBe(false)
    h.pi(JSON.stringify({ type: 'agent_settled', aborted: true }))
    expect(h.sent.at(-1)).toMatchObject({ type: 'prompt', message: 'After the stop' })
    expect(h.sent.at(-1)?.streamingBehavior).toBeUndefined()
  })

  test('a turn that ends in a Pi error fails the Run with Pi’s message; one Pi retried past does not', () => {
    const errorMessage = (text: string) =>
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: text },
      })
    const recovered = piHarness()
    recovered.ready()
    recovered.pi(errorMessage('529 overloaded'))
    recovered.pi(
      JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Fine' }],
          stopReason: 'stop',
        },
      }),
    )
    recovered.pi(JSON.stringify({ type: 'agent_settled', aborted: false }))
    expect(recovered.failures).toEqual([])
    expect(recovered.kinds().at(-1)).toBe('idle')

    const failed = piHarness()
    failed.ready()
    failed.pi(errorMessage('429 rate limit exceeded'))
    failed.pi(JSON.stringify({ type: 'agent_settled', aborted: false }))
    expect(failed.failures).toEqual(['Pi: 429 rate limit exceeded'])
    expect(failed.kinds().at(-1)).not.toBe('idle')
  })

  test('a resumed Run waits idle, and a refused prompt is shown and ends the turn', () => {
    const h = piHarness('')
    h.ready()
    expect(h.kinds()).toEqual(['session', 'idle'])
    expect(h.sent.some((c) => c.type === 'prompt')).toBe(false)
    h.driver.onInput?.(agent.message('Hello'))
    const id = h.sent.at(-1)?.id
    h.pi(
      JSON.stringify({
        type: 'response',
        id,
        command: 'prompt',
        success: false,
        error: 'No model',
      }),
    )
    expect(h.kinds().slice(-2)).toEqual(['error', 'idle'])
  })

  const entry = (offset: number, value: Parameters<typeof JSON.stringify>[0]) => ({
    offset,
    line: JSON.stringify(value),
  })
  const usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.25 } }
  const call = { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls -la' } }
  const edit = {
    type: 'toolCall',
    id: 't2',
    name: 'edit',
    arguments: { path: '/w/a.ts', edits: [{ oldText: 'a', newText: 'b' }] },
  }
  const assistantEnd = {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Weighing it' },
        { type: 'text', text: 'Hello there' },
        call,
        edit,
      ],
      usage,
      stopReason: 'toolUse',
    },
  }
  const failed = {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [],
      usage: { input: 0, output: 0, cost: { total: 0 } },
      stopReason: 'error',
      errorMessage: 'Provider returned 500',
    },
  }

  test('turns Pi’s events into chat: thinking, text, tool calls with results and diffs, and errors', () => {
    const chat = agent.chat(
      [
        entry(0, { ted_pi: 'started', text: 'Start' }),
        entry(1, { type: 'message_start', message: { role: 'assistant', content: [] } }),
        entry(2, {
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Weigh' },
        }),
        entry(3, {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Hello ' },
        }),
        entry(4, {
          type: 'message_update',
          assistantMessageEvent: { type: 'toolcall_end', contentIndex: 2, toolCall: call },
        }),
        entry(5, assistantEnd),
        entry(6, { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: {} }),
        entry(7, {
          type: 'tool_execution_end',
          toolCallId: 't1',
          toolName: 'bash',
          result: { content: [{ type: 'text', text: 'a.ts' }] },
          isError: false,
        }),
        entry(8, {
          type: 'tool_execution_end',
          toolCallId: 't2',
          toolName: 'edit',
          result: { content: [{ type: 'text', text: 'no match' }] },
          isError: true,
        }),
        entry(9, { type: 'message_start', message: { role: 'assistant', content: [] } }),
        entry(10, failed),
        entry(11, { ted_pi: 'idle' }),
      ],
      '/w',
    )
    expect(chat).toEqual([
      expect.objectContaining({ kind: 'user', text: 'Start' }),
      expect.objectContaining({
        kind: 'tool',
        tool: 'Thinking',
        status: 'done',
        output: 'Weighing it',
      }),
      expect.objectContaining({ kind: 'agent', text: 'Hello there', done: true }),
      expect.objectContaining({
        kind: 'tool',
        tool: 'bash',
        title: 'ls -la',
        status: 'done',
        output: 'a.ts',
      }),
      expect.objectContaining({
        kind: 'tool',
        tool: 'edit',
        title: 'a.ts',
        status: 'failed',
        diffs: [expect.objectContaining({ path: 'a.ts' })],
      }),
      expect.objectContaining({ kind: 'agent', text: 'Pi: Provider returned 500', done: true }),
    ])
  })

  test('reads tokens and cost from assistant messages, and never reports limits or credentials', () => {
    const line = JSON.stringify(assistantEnd)
    expect(agent.tokensFrom(line)).toEqual({ input: 13, output: 5, total: false })
    expect(agent.tokensFrom(JSON.stringify(failed))).toBeUndefined()
    expect(agent.costLine(line)).toBe(true)
    expect(agent.costOf([line, line], undefined)).toBeCloseTo(0.5)
    expect(agent.costOf([JSON.stringify(failed)], undefined)).toBeUndefined()
    expect(agent.boundaryFrom(JSON.stringify({ type: 'tool_execution_end' }))).toBe(true)
    expect(agent.retryingFrom(JSON.stringify({ type: 'auto_retry_start' }))).toBe(true)
    expect(agent.retryingFrom(JSON.stringify({ type: 'auto_retry_end' }))).toBe(false)
    const quota = JSON.stringify({
      ...failed,
      message: { ...failed.message, errorMessage: '429 rate limit' },
    })
    expect(agent.usageFrom(quota)).toBeUndefined()
    expect(agent.credentialFrom(quota)).toBeUndefined()
    expect(agent.authErrorFrom(quota)).toBe(false)
    expect(agent.problemFrom(JSON.stringify(failed))).toBeUndefined()
    const missing = {
      ...failed,
      message: { ...failed.message, errorMessage: 'Model not found: x/y' },
    }
    expect(agent.problemFrom(JSON.stringify(missing))).toBe('model-unavailable')
    expect(agent.health.ignoresOfflineAndLimits).toBe(true)
  })

  test('reads Pi’s saved default model without writing it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ted-pi-agent-'))
    try {
      const env = { PI_CODING_AGENT_DIR: dir, HOME: '/nowhere' }
      expect(agent.savedModel?.(env)).toBeUndefined()
      writeFileSync(
        path.join(dir, 'settings.json'),
        JSON.stringify({ defaultProvider: 'ollama', defaultModel: 'gemma4:12b' }),
      )
      expect(agent.savedModel?.(env)).toBe('ollama/gemma4:12b')
      writeFileSync(
        path.join(dir, 'settings.json'),
        JSON.stringify({ defaultModel: 'zai/glm-4.7' }),
      )
      expect(agent.savedModel?.(env)).toBe('zai/glm-4.7')
      writeFileSync(path.join(dir, 'settings.json'), 'not json')
      expect(agent.savedModel?.(env)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('Pi is the default only when no other enabled Provider is installed and Pi is Ready', () => {
    const all = { claude: true, codex: true, antigravity: true, pi: true }
    expect(resolveAgentChoices(undefined, all).lead.agent).toBe('claude')
    expect(resolveAgentChoices(undefined, { pi: true }).lead.agent).toBe('pi')
    expect(
      resolveAgentChoices(undefined, { pi: true }, undefined, { pi: 'Pi lists no models' }).lead
        .agent,
    ).toBe('claude')
    expect(resolveAgentChoices(undefined, all, ['claude', 'pi']).reviewer.agent).toBe('claude')
    expect(
      resolveAgentChoices(undefined, { claude: true, pi: true }, ['pi', 'claude']).lead.agent,
    ).toBe('claude')
    expect(resolveAgentChoices(undefined, { pi: true }, ['pi']).reviewer.agent).toBe('pi')
    const stub = process.execPath
    expect(
      createAgents({
        claudeBin: '/nowhere/claude',
        codexBin: '/nowhere/codex',
        antigravityBin: '/nowhere/agy',
        piBin: stub,
      }).defaultLead(),
    ).toBe('pi')
    expect(
      createAgents({ claudeBin: stub, codexBin: '/nowhere/codex', piBin: stub }).defaultLead(),
    ).toBe('claude')
    expect(
      createAgents({
        claudeBin: '/nowhere/claude',
        codexBin: '/nowhere/codex',
        antigravityBin: '/nowhere/agy',
        piBin: stub,
      }).defaultLead(['claude', 'codex']),
    ).toBe('claude')
  })

  test('accepts Pi at the public sub-agent parser and each workflow role', () => {
    expect(
      parseStartSubAgentRequest({ prompt: 'Review', agent: 'pi', model: 'ollama/gemma4:12b' }),
    ).toMatchObject({
      agent: 'pi',
      model: 'ollama/gemma4:12b',
    })
    const layer = checkLayer({
      kind: 'factory',
      files: { 'workflow.yaml': 'lead: pi\nreviewer: pi\nplanner: pi\n' },
    })
    expect(layer.problems.filter((p) => p.severity === 'error')).toEqual([])
  })
})

describe('Pi’s model list', () => {
  test('reads provider/id from Pi’s get_available_models reply and skips everything else', () => {
    const reply = (data: JsonObject, success = true) =>
      JSON.stringify({ id: 'x', type: 'response', command: 'get_available_models', success, data })
    expect(
      piModelsReply(
        reply({
          models: [
            { provider: 'ollama', id: 'gemma4:12b', name: 'Gemma' },
            { provider: 'zai', id: 'glm-5.3' },
            { provider: 'zai', id: 'glm-5.3' },
            { provider: 'zai' },
            { id: 'no-provider' },
            'junk',
            { provider: 'bad name', id: 'x' },
          ],
        }),
      ),
    ).toEqual(['ollama/gemma4:12b', 'zai/glm-5.3'])
    expect(piModelsReply(reply({ models: [] }))).toEqual([])
    expect(piModelsReply(reply({}, false))).toEqual([])
    expect(
      piModelsReply('{"type":"response","command":"get_state","success":true}'),
    ).toBeUndefined()
    expect(piModelsReply('{"type":"agent_start"}')).toBeUndefined()
    expect(piModelsReply('not json')).toBeUndefined()
  })

  test('asks Pi over RPC, and gives undefined when Pi is missing, exits without answering or floods its output, and stops a Pi that ignores SIGTERM', async () => {
    const piHome = mkdtempSync(path.join(home, 'pi-models-'))
    const env = { ...process.env, TED_HOME: piHome }
    writeFileSync(path.join(piHome, 'stub-pi.json'), JSON.stringify({ models: 1 }))
    expect(await piModels({ binary: stubPiPath, env, cwd: piHome })).toEqual(['stub/model-0'])
    expect(
      await piModels({ binary: path.join(piHome, 'missing-pi'), env, cwd: piHome }),
    ).toBeUndefined()
    const silent = path.join(piHome, 'silent-pi')
    writeFileSync(silent, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    expect(await piModels({ binary: silent, env, cwd: piHome })).toBeUndefined()
    const flooding = path.join(piHome, 'flooding-pi')
    writeFileSync(flooding, `#!/bin/sh\nprintf '%02000d' 0\nexec sleep 600\n`, { mode: 0o755 })
    expect(
      await piModels({ binary: flooding, env, cwd: piHome, maxBytes: 1000, timeoutMs: 600_000 }),
    ).toBeUndefined()
    const stubborn = path.join(piHome, 'stubborn-pi')
    const pidFile = path.join(piHome, 'stubborn-pi.pid')
    writeFileSync(
      stubborn,
      `#!/bin/sh\ntrap '' TERM\necho $$ > '${pidFile}'\nwhile :; do printf '%0100d' 0; done\n`,
      { mode: 0o755 },
    )
    expect(
      await piModels({ binary: stubborn, env, cwd: piHome, maxBytes: 1000, timeoutMs: 600_000 }),
    ).toBeUndefined()
    const pid = Number(readFileSync(pidFile, 'utf8'))
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0)
          return 'running'
        } catch {
          return 'gone'
        }
      })
      .toBe('gone')
  })
})
