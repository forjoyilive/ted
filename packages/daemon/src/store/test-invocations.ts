import { queryDb, type Store } from '@livestore/livestore'
import {
  parseRegisterTestInvocation,
  parseTestInvocationReport,
  type RegisterTestInvocation,
  type TestInvocation,
  type TestInvocationReport,
  type TestInvocationSummary,
  testInvocationLimit,
} from '@ted/protocol'
import { RequestError } from '../errors.ts'
import { redactSecrets } from '../redact.ts'
import { events, type schema, testInvocations } from './schema.ts'

interface Owner {
  taskId: string
  runId?: string
}

export interface TestInvocationStore {
  register(owner: Owner, input: RegisterTestInvocation): TestInvocation
  report(id: string, input: TestInvocationReport): TestInvocation
  get(id: string): TestInvocation | undefined
  summary(taskId: string): TestInvocationSummary
}

export function createTestInvocationStore({
  store,
  commit,
  run,
  check,
  checks,
}: {
  store: Store<typeof schema>
  commit: Store<typeof schema>['commit']
  run(id: string): { taskId?: string; state: string } | undefined
  check(
    id: string,
  ): { taskId: string; finishedAt?: string; checks: { state: string }[] } | undefined
  checks(taskId: string): { id: string; checks: { state: string; started: boolean }[] }[]
}): TestInvocationStore {
  const get = (id: string): TestInvocation | undefined => {
    const row = store.query(queryDb(testInvocations.where({ id })))[0]
    return (
      row && {
        ...(JSON.parse(row.data) as TestInvocation),
        ...(row.ownerEnded && { ownerEnded: true }),
      }
    )
  }
  const list = (taskId: string): TestInvocation[] =>
    store.query(queryDb(testInvocations.where({ taskId }))).map((r) => ({
      ...(JSON.parse(r.data) as TestInvocation),
      ...(r.ownerEnded && { ownerEnded: true }),
    }))
  const save = (value: TestInvocation) => {
    commit(
      events.testInvocationRecorded({
        id: value.id,
        taskId: value.taskId,
        data: JSON.stringify(value),
      }),
    )
    return value
  }
  const conflict = (message: string): never => {
    throw new RequestError(409, message)
  }
  const ownerLive = (
    value: Pick<TestInvocation, 'taskId' | 'runId' | 'checkRunId' | 'position' | 'ownerEnded'>,
  ) => {
    if (value.ownerEnded) return false
    if (value.checkRunId !== undefined) {
      const found = check(value.checkRunId)
      return (
        found?.taskId === value.taskId &&
        !found.finishedAt &&
        found.checks[value.position ?? -1]?.state === 'running'
      )
    }
    const found = value.runId ? run(value.runId) : undefined
    return found?.taskId === value.taskId && found.state !== 'finished'
  }
  const terminal = (value: TestInvocationReport | undefined) =>
    value && ['finished', 'canceled', 'interrupted'].includes(value.kind)
  return {
    get,
    register(owner, given) {
      const input = parseRegisterTestInvocation(given)
      if (owner.runId !== undefined && input.checkRunId !== undefined)
        throw new RequestError(403, 'Runs cannot attribute invocations to Checks')
      if (!owner.runId && !input.checkRunId) conflict('an invocation needs a Run or Check owner')
      const normalized = {
        ...input,
        ...(input.label !== undefined && {
          label: redactSecrets(input.label)
            .split('')
            .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
            .join('')
            .slice(0, 120),
        }),
        ...owner,
      }
      const previous = get(input.id)
      if (previous) {
        const { registeredAt: _at, reports: _reports, ownerEnded: _ended, ...original } = previous
        if (JSON.stringify(original) !== JSON.stringify(normalized))
          conflict('invocation ID is already owned or registered differently')
        return previous
      }
      if (!ownerLive(normalized)) conflict('invocation owner is not live on this Task')
      if (list(owner.taskId).length >= testInvocationLimit)
        conflict('Task invocation limit reached')
      return save({ ...normalized, registeredAt: Date.now(), reports: [] })
    },
    report(id, given) {
      const input = parseTestInvocationReport(given)
      const value = get(id)
      if (!value) throw new RequestError(404, 'no test invocation')
      if (!value.supported) conflict('invocation does not support reporting')
      const previous = value.reports[input.sequence]
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(input))
          conflict('conflicting duplicate report')
        return value
      }
      if (input.sequence !== value.reports.length) conflict('report sequence is out of order')
      if (!ownerLive(value)) conflict('invocation owner has ended')
      const last = value.reports.at(-1)
      if (terminal(last)) conflict('invocation is already closed')
      if (
        input.at < (last?.at ?? value.registeredAt) ||
        input.at > Date.now() + 5_000 ||
        input.at - value.registeredAt > 7 * 86_400_000
      )
        conflict('report timestamp is outside the invocation lifetime')
      const waiting = last?.kind === 'wait-start'
      if (
        (input.kind === 'wait-start' && waiting) ||
        (input.kind === 'wait-end' && !waiting) ||
        (input.kind === 'finished' && waiting)
      )
        conflict('invalid wait transition')
      if (input.sequence === 63 && !terminal(input))
        conflict('last report must close the invocation')
      return save({ ...value, reports: [...value.reports, input] })
    },
    summary(taskId) {
      const values = list(taskId)
      const checksWithoutReports: TestInvocationSummary['checksWithoutReports'] = []
      let checksWithoutReportsOmitted = 0
      for (const checkRun of checks(taskId)) {
        for (const [position, result] of checkRun.checks.entries()) {
          if (!result.started && ['waiting', 'skipped', 'not-run'].includes(result.state)) continue
          if (values.some((i) => i.checkRunId === checkRun.id && i.position === position)) continue
          if (checksWithoutReports.length >= testInvocationLimit) checksWithoutReportsOmitted++
          else
            checksWithoutReports.push({ checkRunId: checkRun.id, position, coverage: 'unreported' })
        }
      }
      return {
        version: 1,
        directCommands:
          'Only registered invocations are measured; other direct commands are outside coverage.',
        limitReached: values.length >= testInvocationLimit,
        checksWithoutReports,
        checksWithoutReportsOmitted,
        invocations: values.map((value) => {
          let confirmedWaitMs = 0
          let openWaitStartedAt: number | undefined
          for (const report of value.reports) {
            if (report.kind === 'wait-start') openWaitStartedAt = report.at
            else if (openWaitStartedAt !== undefined) {
              confirmedWaitMs += report.at - openWaitStartedAt
              openWaitStartedAt = undefined
            }
          }
          const last = value.reports.at(-1)
          const outcome = terminal(last)
            ? (last?.kind as 'finished' | 'canceled' | 'interrupted')
            : undefined
          return {
            ...value,
            coverage: !value.supported
              ? ('unsupported' as const)
              : !outcome && !ownerLive(value)
                ? ('incomplete' as const)
                : value.reports.length === 0
                  ? ('unreported' as const)
                  : ('reported' as const),
            confirmedWaitMs,
            ...(openWaitStartedAt !== undefined && { openWaitStartedAt }),
            ...(outcome && { outcome }),
          }
        }),
      }
    },
  }
}
