import type { ChatAgent, Comment, Factory, Task } from '@ted/protocol'

export const createdAt = '2026-11-09T12:00:00.000Z'

export const coordinatorAgent: ChatAgent = {
  id: 'coordinator',
  name: 'Coordinator',
  source: 'ted',
  powers: ['ask', 'manage_tasks', 'manage_automations', 'manage_agents'],
  removed: false,
}

export const plannerAgent: ChatAgent = {
  id: 'planner',
  name: 'Planner',
  source: 'ted',
  powers: ['ask', 'propose_tasks', 'read_code'],
  removed: false,
}

export function factory(fields: Partial<Factory> = {}): Factory {
  return {
    id: 'f1',
    key: 'NB',
    name: 'widgets',
    repo: 'acme/widgets',
    defaultBranch: 'main',
    repos: [{ repo: 'acme/widgets', name: 'widgets' }],
    cloned: true,
    position: 0,
    createdAt,
    ...fields,
  }
}

export function task(fields: Partial<Task> = {}): Task {
  return {
    id: 'NB-1',
    displayId: 'NB-1',
    factoryId: 'f1',
    number: 1,
    title: 'Sync notes',
    description: 'Keep editing offline.',
    priority: 'none',
    clarifyDepth: 'auto',
    blockedBy: [],
    attachments: [],
    stage: 'backlog',
    rank: 1,
    statuses: [],
    markers: [],
    track: [
      { stage: 'intake', state: 'future' },
      { stage: 'work', state: 'future' },
    ],
    commentBox: 'no-run',
    runs: [],
    tabs: [],
    repos: [],
    chosenRepos: ['acme/widgets'],
    createdBy: 'human',
    createdAt,
    updatedAt: createdAt,
    ...fields,
  }
}

export function comment(fields: Partial<Comment> = {}): Comment {
  return {
    id: 'c1',
    taskId: 'NB-1',
    kind: 'question',
    body: 'Use the default?',
    author: { kind: 'ted' },
    createdAt,
    ...fields,
  }
}

export function settingsView(): import('@ted/protocol').FactorySettingsView {
  return {
    agentFiles: [],
    factoryId: 'f1',
    repo: 'acme/widgets',
    defaultBranch: 'main',
    source: 'file',
    version: 'v1',
    repos: [
      {
        was: 'widgets',
        repo: 'acme/widgets',
        name: 'widgets',
        primary: true,
        env: [],
        copy: [],
        apps: [],
      },
    ],
    problems: [],
    github: { ready: true },
    stages: [
      { id: 'intake', name: 'Intake', inOrder: true, enabled: true, gate: false, from: 'ted' },
      { id: 'design', name: 'Design', inOrder: true, enabled: true, gate: true, from: 'ted' },
      { id: 'work', name: 'Work', inOrder: true, enabled: true, gate: false, from: 'ted' },
      {
        id: 'review',
        name: 'Review',
        inOrder: true,
        enabled: true,
        gate: true,
        maxBack: 3,
        from: 'ted',
        inherited: { layer: 'ted', text: '# Review\n' },
      },
    ],
    ignoredStageFiles: [],
    checks: [{ was: 0, name: 'Typecheck', run: 'npm run typecheck' }],
    instructionChecks: [],
    cleanup: { enabled: false, steps: [] },
    tries: [],
    agents: [
      { role: 'lead', inherited: { agent: 'claude' }, inheritedFrom: 'ted', from: 'ted' },
      { role: 'reviewer', inherited: { agent: 'codex' }, inheritedFrom: 'ted', from: 'ted' },
      { role: 'planner', inherited: { agent: 'claude' }, inheritedFrom: 'ted', from: 'ted' },
    ],
    permissions: 'auto',
    machineMaxWorkingRuns: 6,
    sandboxSockets: [],
    electronApps: [],
    networkGrants: [],
    notes: '',
  }
}
