import { expect, test } from 'vitest'
import type { ProcessInfo } from '../src/diagnostics.ts'
import { agentBreakdown, type MemoryUse, processName } from '../src/memory.ts'

const row = { pid: 1, ppid: 0, cpuPercent: 0, memoryBytes: 0, command: 'node' }

test('each process is named so it can be found in Activity Monitor', () => {
  const lead = { runId: 'aaaaaaaa-1', agent: 'claude', role: 'task-lead', task: 'TED-487' } as const
  const named = (process: Omit<ProcessInfo, keyof typeof row>) =>
    processName({ ...row, ...process })
  expect(named({ owner: 'app', kind: 'ted-app' })).toBe('Ted app')
  expect(named({ owner: 'daemon', kind: 'daemon' })).toBe('Ted daemon')
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
  expect(named({ owner: 'daemon', kind: 'check' })).toBe('Scheduled check')
  expect(named({ owner: 'daemon', kind: 'app', task: 'TED-479', appName: 'Ted Dev' })).toBe(
    'App “Ted Dev” of TED-479',
  )
  expect(named({ owner: 'daemon', kind: 'other' })).toBe('Other Ted command')
})

test('the agent breakdown names each kind of Run in order, leaving out kinds with none', () => {
  const none = { count: 0, bytes: 0 }
  const use: MemoryUse = {
    daemon: { bytes: 0, heapBytes: 0, externalBytes: 0 },
    hosts: none,
    agents: none,
    agentTools: none,
    checks: none,
    apps: none,
    other: none,
    store: { eventLogBytes: 0, stateBytes: 0 },
  }
  expect(agentBreakdown(use)).toEqual([])
  expect(
    agentBreakdown({
      ...use,
      agentRuns: [
        { role: 'run', working: true, count: 1 },
        { role: 'automation', working: true, count: 2 },
        { role: 'side-chat', working: true, count: 1 },
        { role: 'planning', working: true, count: 1 },
        { role: 'task-lead', working: true, count: 1 },
      ],
    }),
  ).toEqual(['1 Task Lead', '2 chats', '2 Automations', '1 other Run'])
  expect(
    agentBreakdown({
      ...use,
      agentRuns: [
        { role: 'automation', working: false, count: 1 },
        { role: 'sub-agent', working: false, count: 2 },
      ],
    }),
  ).toEqual(['2 sub-agents', '1 Automation', '3 idle'])
})
