import { expect, test } from 'vitest'
import type { ProcessInfo } from '../src/diagnostics.ts'
import { processName } from '../src/memory.ts'

const row = { pid: 1, ppid: 0, cpuPercent: 0, memoryBytes: 0, command: 'node' }

test('each process is named so it can be found in Activity Monitor', () => {
  const lead = { runId: 'aaaaaaaa-1', agent: 'claude', role: 'task-lead', task: 'TED-487' } as const
  const named = (process: Omit<ProcessInfo, keyof typeof row>) =>
    processName({ ...row, ...process })
  expect(named({ owner: 'app', kind: 'ted-app' })).toBe('TED app')
  expect(named({ owner: 'daemon', kind: 'daemon' })).toBe('TED daemon')
  expect(named({ owner: { runId: lead.runId }, kind: 'run-host', run: lead })).toBe(
    'Run host of TED-487’s Task Lead',
  )
  expect(named({ owner: { runId: lead.runId }, kind: 'agent', run: lead })).toBe(
    'Claude Code agent of TED-487’s Task Lead',
  )
  expect(
    named({
      owner: { runId: 'b' },
      kind: 'agent-tool',
      run: { runId: 'b', agent: 'codex', role: 'sub-agent', task: 'TED-12' },
    }),
  ).toBe('Tool or MCP server of a sub-agent of TED-12')
  expect(
    named({
      owner: { runId: 'c' },
      kind: 'agent',
      run: { runId: 'c', agent: 'codex', role: 'coordinator' },
    }),
  ).toBe('Codex agent of a Coordinator chat')
  expect(named({ owner: 'daemon', kind: 'check', task: 'TED-479' })).toBe('Check of TED-479')
  expect(named({ owner: 'daemon', kind: 'check' })).toBe('Scheduled Check')
  expect(named({ owner: 'daemon', kind: 'app', task: 'TED-479', appName: 'TED Dev' })).toBe(
    'App “TED Dev” of TED-479',
  )
  expect(named({ owner: 'daemon', kind: 'other' })).toBe('Other TED command')
})
