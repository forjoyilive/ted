import path from 'node:path'
import type { SubAgentWait } from '@ted/protocol'
import { expect, test } from 'vitest'
import { openStore } from '../src/store/index.ts'
import { createSendBackHold } from '../src/tasks/send-back-hold.ts'
import { resolveWorkflow } from '../src/workflow/resolve.ts'
import { makeTempHome } from './helpers.ts'

const cases = [
  {
    name: 'converging below the limit',
    message: 'Earlier fixes held.\nVerdict: converging',
    verdict: 'converging',
    releases: true,
  },
  {
    name: 'looping',
    message: 'The same issue returned.\nVerdict: looping',
    verdict: 'looping',
    question: 'without getting closer to done',
  },
  {
    name: 'unknown',
    message: 'Evidence is incomplete.',
    verdict: 'failed',
    question: 'couldn’t check progress',
    reason: 'the loop check gave no verdict',
  },
  {
    name: 'failed despite a verdict',
    message: 'Verdict: converging',
    error: 'Run failed',
    verdict: 'failed',
    question: 'couldn’t check progress',
    reason: 'the loop check didn’t finish',
  },
  {
    name: 'converging at the limit',
    message: 'Earlier fixes held.\nVerdict: converging',
    verdict: 'converging',
    atLimit: true,
    question: 'its limit',
  },
]

test.each(cases)(
  '$name',
  async ({ message, error, verdict, releases, atLimit, question, reason }) => {
    const { home, cleanup } = await makeTempHome()
    const store = await openStore({ directory: path.join(home, 'store') })
    try {
      const { id } = await store.createTask({ title: 'Validate send-back' })
      store.changeStage(id, 'validate')
      const find = (taskId: string) => {
        const task = store.getTask(taskId)
        if (task === undefined) throw new Error('Missing test Task')
        return task
      }
      const workflow = resolveWorkflow([])
      workflow.settings.stages.validate = { loop_check: 1, max_back: 1 }
      const resolution = { workflow, layers: [] }
      const findings = 'Fix the remaining issue.'
      if (atLimit) {
        store.recordSendBack({
          taskId: id,
          from: 'validate',
          to: 'work',
          findings: 'Earlier issue.',
          counted: true,
          round: 1,
        })
      }
      const scheduled: (() => Promise<void>)[] = []
      const runId = 'loop-check'
      const result: SubAgentWait = {
        id: runId,
        name: 'Loop check · Validate',
        agent: 'codex',
        state: 'idle',
        done: true,
        message,
        ...(error !== undefined && { error }),
      }
      const hold = createSendBackHold({
        store,
        subAgents: {
          requestForTed: (_task, input) => {
            expect(input.purpose).toBe('loop-check')
            expect(input.prompt).toContain(findings)
            return runId
          },
          result: async (id) => {
            expect(id).toBe(runId)
            return result
          },
        },
        reviewerFor: async () => ({ lead: { agent: 'codex' } }),
        find,
        taskWorkflow: async () => resolution,
        stopRun: async () => {
          throw new Error('No real Run should be stopped')
        },
        closed: () => false,
        inBackground: (_label, work) => {
          scheduled.push(work)
        },
        move: async (task, _resolution, stage) => store.changeStage(task.id, stage),
        backMessage: () => 'Back to Work',
        deliver: async () => {
          throw new Error('A Check run has no Validate Task Lead to notify')
        },
      })

      expect(
        await hold.decide(find(id), workflow, {
          to: 'work',
          findings,
          counted: true,
          count: atLimit ? 1 : 0,
          limit: 1,
          checkRunId: 'check',
        }),
      ).toMatchObject({ kind: 'checking' })
      expect(hold.heldFor(id, 'check')).toBe(true)
      expect(hold.refuseOutcome(find(id))).toContain('wait for its verdict')
      expect(scheduled).toHaveLength(1)
      await scheduled[0]?.()

      expect(store.loopChecks(id)).toMatchObject([{ verdict }])
      if (releases) {
        expect(find(id).stage).toBe('work')
        expect(store.listSendBacks(id)).toMatchObject([{ findings, round: 1, cause: 'check' }])
        expect(hold.pending(id)).toBe(false)
      } else {
        expect(find(id).stage).toBe('validate')
        expect(store.listSendBacks(id)).toHaveLength(atLimit ? 1 : 0)
        expect(hold.openSendBackAsk(find(id))).toMatchObject({
          title: expect.stringContaining(question ?? ''),
          choices: ['Keep going', 'Stop the Task'],
          ...(reason !== undefined && { body: expect.stringContaining(reason) }),
        })
        expect(hold.refuseOutcome(find(id))).toContain('wait for their answer')
      }
    } finally {
      await store.close()
      await cleanup()
    }
  },
)
