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
      files: [],
      invariants: ['production transport reconciliation'],
      timeoutMs: 0,
      prerequisites: ['production transport adapter'],
      unavailable:
        'Production transport/service adapters belong to their owning implementation Tasks.',
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
      files: [],
      invariants: ['GUI behavior'],
      timeoutMs: 0,
      prerequisites: ['qualifying GUI scenario'],
      unavailable: 'This harness changes no GUI and supplies no GUI evidence.',
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
