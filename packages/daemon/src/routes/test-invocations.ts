import {
  parseRegisterTestInvocation,
  parseTestInvocationReport,
  testInvocationId,
  testReporterSubject,
} from '@ted/protocol'
import { RequestError } from '../errors.ts'
import type { TedStore } from '../store/index.ts'
import type { Caller } from '../tasks/tasks.ts'
import { jsonRoute, type Route } from './route.ts'

function taskFor(store: TedStore, ref: string, caller: Caller) {
  const task = store.getTask(ref)
  if (!task) throw new RequestError(404, 'no Task')
  if (caller.kind === 'run' && store.getRun(caller.runId)?.taskId !== task.id)
    throw new RequestError(403, 'this Run does not own this Task')
  return task
}

export const testInvocationRoutes: Route[] = [
  jsonRoute(parseRegisterTestInvocation, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/test-invocations$/,
    runToken: true,
    async handle({ params: [ref = ''], body, caller }, { store, runTokens }) {
      const task = taskFor(store, ref, caller)
      const invocation = store.testInvocations.register(
        { taskId: task.id, ...(caller.kind === 'run' && { runId: caller.runId }) },
        body,
      )
      return [200, { invocation, token: runTokens.issue(testReporterSubject(invocation)) }]
    },
  }),
  jsonRoute(parseTestInvocationReport, {
    method: 'POST',
    path: /^\/test-invocations\/([^/]+)\/reports$/,
    runToken: true,
    async handle({ params: [ref = ''], body, caller }, { store }) {
      const id = testInvocationId(ref)
      const invocation = store.testInvocations.get(id)
      if (!invocation || caller.kind !== 'run' || caller.runId !== testReporterSubject(invocation))
        throw new RequestError(403, 'an invocation reporting credential is required')
      store.testInvocations.report(id, body)
      return [200, { recorded: true }]
    },
  }),
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/test-invocations$/,
    runToken: true,
    async handle({ params: [ref = ''], caller }, { store }) {
      const task = taskFor(store, ref, caller)
      const summary = store.testInvocations.summary(task.id)
      return [200, summary]
    },
  },
]
