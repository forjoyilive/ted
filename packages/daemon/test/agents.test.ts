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
