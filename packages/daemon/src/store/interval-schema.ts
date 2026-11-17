import { State } from '@livestore/livestore'

export const intervalBoundaries = State.SQLite.table({
  name: 'intervalBoundaries',
  indexes: [
    { name: 'idx_intervalBoundaries_subject', columns: ['subject', 'sequence'] },
    { name: 'idx_intervalBoundaries_sequence', columns: ['sequence'] },
  ],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    sequence: State.SQLite.integer(),
    subject: State.SQLite.text(),
    name: State.SQLite.text(),
    data: State.SQLite.text(),
    at: State.SQLite.text(),
  },
})

type Args = Record<string, unknown>

function boundary(
  name: string,
  args: Args,
): { subject: string; data: Args; at: string } | undefined {
  if (isRunStarted(name)) {
    return { subject: `run:${args.id}`, data: { state: 'working' }, at: String(args.startedAt) }
  }
  if (name === 'v1.RunStateChanged' || name === 'v1.RunStateObserved') {
    return { subject: `run:${args.runId}`, data: { state: args.state }, at: String(args.at) }
  }
  if (name === 'v1.RunRevived' || name === 'v1.RunRestarted' || name === 'v1.RunProblemFound') {
    return {
      subject: `run:${args.runId}`,
      data: {
        state: name.endsWith('Revived')
          ? 'working'
          : name.endsWith('Restarted')
            ? 'idle'
            : 'waiting',
      },
      at: String(args.at),
    }
  }
  if (
    (/^v[1234]\.(?:Ted)?CommentPosted$/.test(name) && args.kind !== 'note') ||
    name === 'v1.PermissionRequested'
  ) {
    return {
      subject: `task:${args.taskId}`,
      data: { intervalRequestId: args.id },
      at: String(args.createdAt),
    }
  }
  if (name === 'v1.TaskLeadFailed' && args.ask !== null && typeof args.ask === 'object') {
    return {
      subject: `task:${args.taskId}`,
      data: { intervalRequestId: (args.ask as Args).id, recovery: args.recovery },
      at: String(args.at),
    }
  }
  if (isSubAgentRequested(name)) {
    return {
      subject: `task:${args.taskId}`,
      data: { queuedRunId: args.id, agent: args.agent },
      at: String(args.at),
    }
  }
  if (name === 'v1.SubAgentRequestDropped') {
    return { subject: `sub-agent:${args.id}`, data: { id: args.id }, at: String(args.at) }
  }
  if (name === 'v1.AgentPaused' || name === 'v1.AgentResumed') {
    return {
      subject: 'agent',
      data: { agent: args.agent, reason: args.reason ?? null },
      at: String(args.at),
    }
  }
  if (/^v[12]\.PullRequest(?:Opened|Closed|Reopened)$/.test(name)) {
    return {
      subject: `task:${args.taskId}`,
      data: { repo: args.name, number: args.number ?? null, state: args.state ?? null },
      at: String(args.at),
    }
  }
  if (name === 'v1.PullRequestWaitChanged') {
    return {
      subject: `task:${args.taskId}`,
      data: { repo: args.name, github: args.on },
      at: String(args.at),
    }
  }
  if (name === 'v1.TaskDequeued' || name === 'v1.TaskStarted' || name === 'v1.TaskStageChanged') {
    return {
      subject: `task:${args.taskId}`,
      data: { stage: args.stage ?? null },
      at: String(args.at),
    }
  }
  if (name === 'v1.TaskWaitObserved') {
    return { subject: `task:${args.taskId}`, data: { reasons: args.reasons }, at: String(args.at) }
  }
  if (name.startsWith('v1.IntervalObservation')) {
    return {
      subject: 'observation',
      data: { sessionId: args.sessionId, previousObservedAt: args.previousObservedAt ?? null },
      at: String(args.at),
    }
  }
  return undefined
}

export function withIntervalBoundaries<T extends Record<string, (...args: never[]) => unknown>>(
  handlers: T,
): T {
  // SAFETY: each wrapper keeps its handler's name and arguments and adds rows to its result.
  return Object.fromEntries<unknown>(
    Object.entries(handlers).map(([name, handler]) => {
      const call = handler as (
        args: Args,
        context: { event: { seqNum: { global: number; client: number } } },
      ) => unknown
      return [
        name,
        (args: Args, context: { event: { seqNum: { global: number; client: number } } }) => {
          const result = call(args, context)
          const row = boundary(name, args)
          if (!row) return result
          const { global, client } = context.event.seqNum
          return [
            ...(Array.isArray(result) ? result : [result]),
            intervalBoundaries
              .insert({
                ...row,
                id: `${global}.${client}`,
                sequence: global * 1_000_000 + client,
                name,
                data: JSON.stringify(row.data),
              })
              .onConflict('id', 'replace'),
          ]
        },
      ]
    }),
  ) as T
}

export function isSubAgentRequested(name: string): boolean {
  return name === 'v1.SubAgentRequested' || name === 'v2.SubAgentRequested'
}

export function isRunStarted(name: string): boolean {
  return /^v[2345]\.RunStarted$/.test(name)
}
