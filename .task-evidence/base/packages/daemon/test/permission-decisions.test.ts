import { describe, expect, test } from 'vitest'
import { hidesText } from '../src/agents/agent.ts'
import { claudeAgent } from '../src/agents/claude.ts'
import { codexAgent } from '../src/agents/codex.ts'

const claude = claudeAgent('/nowhere/claude')
const codex = codexAgent('/nowhere/codex')
const askCodex = (method: string, params: Record<string, unknown>) =>
  codex.permissionPromptFrom(JSON.stringify({ id: 1, method, params }), () => undefined)

describe('permission decisions', () => {
  test('every field a Claude Code tool call would use is on the card and in the approved input', () => {
    const input = { file_path: '/etc/hosts', content: '127.0.0.1 registry.npmjs.org\n' }
    const prompt = claude.permissionPromptFrom(
      JSON.stringify({
        type: 'control_request',
        request_id: 'req-1',
        request: { subtype: 'can_use_tool', tool_name: 'Write', input },
      }),
      () => undefined,
    )
    expect(prompt).toMatchObject({
      requestId: 'req-1',
      title: 'Write a file',
      command: '/etc/hosts',
      input,
    })
    expect(JSON.parse(prompt?.details ?? '{}')).toEqual({ content: input.content })
    const replies = claude.permissionReply({
      requestId: 'req-1',
      approved: true,
      input: prompt?.input,
    })
    expect(JSON.parse(replies[0] ?? '{}')).toMatchObject({
      response: { request_id: 'req-1', response: { behavior: 'allow', updatedInput: input } },
    })
  })

  test.each([
    { command: ['ls'], escalate: true },
    { command: ['ls', 7] },
    { command: [] },
    { command: 'ls' },
  ])('legacy commands with unknown fields or invalid arguments are refused: %j', (params) => {
    expect(askCodex('execCommandApproval', params)?.refuse).toBe(true)
  })

  test('a legacy command quotes arguments containing shell syntax', () => {
    const prompt = askCodex('execCommandApproval', {
      command: ['sh', '-c', "echo 'hi' && rm -rf build"],
    })
    expect(prompt?.command).toBe(`sh -c 'echo '\\''hi'\\'' && rm -rf build'`)
    expect(prompt?.refuse).not.toBe(true)
  })

  test.each([
    { command: 'ls', sandboxOverride: 'none' },
    { command: 'ls', kind: 'writeStdin' },
    { command: 'ls', networkApprovalContext: { protocol: 'https' } },
    { command: '' },
    { command: 'ls', availableDecisions: ['cancel'] },
    { command: 'ls', availableDecisions: 'accept' },
  ])('modern commands with unshowable access are refused: %j', (params) => {
    expect(askCodex('item/commandExecution/requestApproval', params)?.refuse).toBe(true)
  })

  test('a modern command that lists the decisions Codex takes is asked, not refused', () => {
    const prompt = askCodex('item/commandExecution/requestApproval', {
      kind: 'command',
      command: "/bin/zsh -lc 'git add a.ts && git commit -m x'",
      cwd: '/work',
      startedAtMs: 1,
      environmentId: 'local',
      proposedExecpolicyAmendment: ['git', 'add', 'a.ts'],
      availableDecisions: [
        'accept',
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'add', 'a.ts'] } },
        'cancel',
      ],
    })
    expect(prompt?.refuse).not.toBe(true)
    expect(prompt?.command).toBe("/bin/zsh -lc 'git add a.ts && git commit -m x'")
  })

  test('access grants carry only the access shown, and unknown access is refused', () => {
    const prompt = askCodex('item/permissions/requestApproval', {
      permissions: { network: null, fileSystem: { read: null, write: ['/tmp/cache'] } },
    })
    expect(prompt).toMatchObject({
      command: 'write /tmp/cache',
      input: { fileSystem: { read: null, write: ['/tmp/cache'] } },
    })
    expect(
      askCodex('item/permissions/requestApproval', {
        permissions: { network: { enabled: true }, macos: { accessibility: true } },
      })?.refuse,
    ).toBe(true)
  })

  test.each(['\u202e', '\u200b', '\u001b'])(
    'hidden or direction-changing text is unsafe: %j',
    (hidden) => {
      expect(
        hidesText({ requestId: '1', title: 'Run a command', command: `ls ${hidden}file` }),
      ).toBe(true)
    },
  )
})
