export type EvidenceKind =
  | 'isolated loopback integration'
  | 'actual two-Mac execution'
  | 'native-sandbox evidence'
  | 'GUI evidence'

export interface ExecutionScenario {
  id: string
  evidence: EvidenceKind
  scope: 'fixture controls' | 'production behavior'
  files: string[]
  invariants: string[]
  timeoutMs: number
  prerequisites: string[]
  unavailable?: string
}

export const executionManifest: { version: 1; scenarios: ExecutionScenario[] } = {
  version: 1,
  scenarios: [
    {
      id: 'fixture-controls',
      evidence: 'isolated loopback integration',
      scope: 'fixture controls',
      files: ['packages/daemon/test/execution-fixture.test.ts'],
      timeoutMs: 180_000,
      prerequisites: [
        'Node 24',
        'pnpm dependencies',
        'Git',
        'loopback sockets and process inspection',
      ],
      invariants: ['isolation', 'fault-controls', 'process-restart', 'machine-controls'],
    },
    {
      id: 'ownership',
      evidence: 'isolated loopback integration',
      scope: 'production behavior',
      files: ['packages/daemon/test/execution-validation.test.ts'],
      timeoutMs: 180_000,
      prerequisites: ['Node 24', 'pnpm dependencies', 'Git', 'local ownership implementation'],
      invariants: ['ownership-replay', 'ownership-start'],
    },
    {
      id: 'reporting',
      evidence: 'isolated loopback integration',
      scope: 'fixture controls',
      files: ['scripts/validate-execution.test.ts'],
      timeoutMs: 120_000,
      prerequisites: ['Node 24', 'pnpm dependencies', 'Git', 'writable durable report directory'],
      invariants: ['runner-reporting'],
    },
    {
      id: 'local-lifecycle',
      evidence: 'isolated loopback integration',
      scope: 'production behavior',
      files: [
        'packages/daemon/test/local-lifecycle.test.ts',
        'packages/daemon/test/execution-lifecycle.test.ts',
        'packages/daemon/test/worktrees.test.ts',
        'packages/daemon/test/worktree-copy.test.ts',
        'packages/daemon/test/multi-repo-tasks.test.ts',
        'packages/daemon/test/setup-task.test.ts',
        'packages/daemon/test/sub-agents.test.ts',
      ],
      invariants: ['lifecycle-handles', 'lifecycle-revocation', 'lifecycle-process'],
      timeoutMs: 600_000,
      prerequisites: [
        'Node 24',
        'pnpm dependencies',
        'Git',
        'local lifecycle implementation',
        'native sandbox',
      ],
    },
    {
      id: 'production-transport',
      evidence: 'isolated loopback integration',
      scope: 'production behavior',
      files: [
        'packages/protocol/test/execution-pairing.test.ts',
        'packages/daemon/test/execution-pairing.test.ts',
      ],
      invariants: [
        'pairing-peer-refusals',
        'pairing-expiry',
        'pairing-human-authority',
        'pairing-restart',
        'pairing-revocation',
      ],
      timeoutMs: 300_000,
      prerequisites: [
        'Node 24',
        '/usr/bin/openssl',
        'process inspection and native child launches',
        'production pairing transport',
      ],
    },
    {
      id: 'pairing-repairs',
      evidence: 'isolated loopback integration',
      scope: 'production behavior',
      files: [
        'packages/daemon/test/execution-pairing.test.ts',
        'scripts/execution-lab.test.ts',
        'packages/app/test/updates-app.test.ts',
      ],
      invariants: [
        'pairing-peer-refusals',
        'pairing-expiry',
        'pairing-human-authority',
        'pairing-restart',
        'pairing-revocation',
        'pairing-shell-readiness',
        'pairing-lab-cleanup',
        'pairing-lab-interface',
        'worker-update-handover',
        'worker-update-cli-owned',
      ],
      timeoutMs: 360_000,
      prerequisites: [
        'Node 24',
        '/usr/bin/openssl',
        'installed Electron and unattended native app launch',
        'production pairing transport',
      ],
    },
    {
      id: 'pairing-lifecycle',
      evidence: 'isolated loopback integration',
      scope: 'production behavior',
      files: [
        'packages/daemon/test/execution-pairing.test.ts',
        'packages/app/test/app-execution-pairing.test.ts',
        'packages/app/test/updates-app.test.ts',
      ],
      invariants: [
        'pairing-peer-refusals',
        'pairing-expiry',
        'pairing-human-authority',
        'pairing-restart',
        'pairing-revocation',
        'pairing-direct-repair',
        'pairing-cli-replacement',
        'pairing-app-replacement',
        'pairing-ui',
        'worker-only-lifecycle',
        'worker-startup-quit',
        'worker-update-handover',
        'worker-update-cli-owned',
        'worker-startup-update',
        'worker-update-start-refused',
      ],
      timeoutMs: 360_000,
      prerequisites: [
        'Node 24',
        '/usr/bin/openssl',
        'installed Electron and unattended native app launch',
        'production pairing transport',
      ],
    },
    {
      id: 'pairing-replacement',
      evidence: 'isolated loopback integration',
      scope: 'production behavior',
      files: [
        'packages/daemon/test/execution-pairing.test.ts',
        'packages/app/test/app-execution-pairing.test.ts',
        'scripts/execution-lab.test.ts',
      ],
      invariants: [
        'pairing-cli-replacement',
        'pairing-app-replacement',
        'pairing-direct-repair',
        'pairing-restart',
        'pairing-lab-interface',
        'pairing-lab-cleanup',
        'worker-startup-quit',
      ],
      timeoutMs: 360_000,
      prerequisites: [
        'Node 24',
        '/usr/bin/openssl',
        'installed Electron and unattended native app launch',
        'production pairing transport',
      ],
    },
    {
      id: 'product-pairing',
      evidence: 'actual two-Mac execution',
      scope: 'production behavior',
      files: [],
      invariants: [
        'two-mac-pairing',
        'two-mac-worker-restart',
        'two-mac-peer-refusal',
        'two-mac-revocation',
      ],
      timeoutMs: 300_000,
      prerequisites: [
        'explicit lab opt-in',
        'two distinct Macs on the same reachable LAN',
        'product pairing adapter',
      ],
      unavailable:
        'Run through validate-execution-lab.ts --action acceptance --scenario product-pairing; normal validation does not contact real hosts.',
    },
    {
      id: 'two-mac',
      evidence: 'actual two-Mac execution',
      scope: 'production behavior',
      files: [],
      invariants: ['execution on two separate Macs'],
      timeoutMs: 0,
      prerequisites: ['lab opt-in', 'real-machine adapter', 'two independent Macs'],
      unavailable:
        'TED-110 supplies lab access; no real-machine adapter is installed in this harness.',
    },
    {
      id: 'native-sandbox',
      evidence: 'native-sandbox evidence',
      scope: 'production behavior',
      files: ['packages/daemon/test/lifecycle-sandbox.test.ts'],
      invariants: ['lifecycle-native-sandbox'],
      timeoutMs: 180_000,
      prerequisites: [
        'macOS',
        'native /usr/bin/sandbox-exec',
        'Node 24',
        'pnpm dependencies',
        'Git',
      ],
    },
    {
      id: 'gui',
      evidence: 'GUI evidence',
      scope: 'production behavior',
      files: ['packages/app/test/app-execution-pairing.test.ts'],
      invariants: ['pairing-ui', 'worker-only-lifecycle'],
      timeoutMs: 240_000,
      prerequisites: [
        'installed Electron',
        'unattended native app launch',
        'pairing UI implementation',
      ],
    },
  ],
}

export function selectScenarios(ids: string[]): ExecutionScenario[] {
  if (ids.length === 0) throw new Error('select at least one --scenario; no default full run')
  return [...new Set(ids)].map((id) => {
    const scenario = executionManifest.scenarios.find((s) => s.id === id)
    if (!scenario) throw new Error(`unknown scenario: ${id}`)
    return scenario
  })
}
