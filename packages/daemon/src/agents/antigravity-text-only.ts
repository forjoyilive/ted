import path from 'node:path'

const name = 'ted-text-only'
const agent = `---
name: ${name}
description: Answer using only the supplied conversation context.
tools: []
mcpServers: []
skills: []
plugins: []
mainAgent: true
subagent: false
commandExecutionPolicy: "off"
---
Answer using only the supplied conversation context.
`

export function antigravityTextOnly(runDir: string) {
  const profile = path.join(runDir, 'antigravity-isolated')
  const cwd = path.join(runDir, 'antigravity-text-only')
  const settings = {
    toolPermission: 'strict',
    permissions: {
      allow: [],
      ask: [],
      deny: [
        'command(*)',
        'read_file(*)',
        'write_file(*)',
        'read_url(*)',
        'execute_url(*)',
        'mcp(*)',
      ],
    },
    allowNonWorkspaceAccess: false,
    enableTerminalSandbox: true,
    disableSlashCommands: true,
    statusLine: { enabled: false },
    title: { enabled: false },
  }
  return {
    cwd,
    args: [
      '--gemini-dir',
      profile,
      '--include-default-customizations=false',
      '--agent',
      name,
      '--sandbox',
    ],
    files: {
      'antigravity-isolated/antigravity-cli/settings.json': JSON.stringify(settings),
      'antigravity-isolated/config/agents/ted-text-only.md': agent,
      'antigravity-isolated/config/hooks.json': '{}',
      'antigravity-isolated/config/mcp_config.json': '{"mcpServers":{}}',
      'antigravity-text-only/.agents/hooks.json': '{}',
      'antigravity-text-only/.agents/mcp_config.json': '{"mcpServers":{}}',
      'antigravity-text-only/.agents/agents/ted-text-only.md': agent,
      // A private repository root prevents discovery from reaching an enclosing dev checkout.
      'antigravity-text-only/.git/HEAD': 'ref: refs/heads/main\n',
      'antigravity-text-only/.git/config': '[core]\nrepositoryformatversion = 0\nbare = false\n',
      'antigravity-text-only/.git/objects/.keep': '',
      'antigravity-text-only/.git/refs/heads/.keep': '',
    },
  }
}
