import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { openStore } from '../src/store/index.ts'
import { createFailureCases } from '../src/tasks/failure-cases.ts'

test.each(['changed', 'unavailable', 'restored', 'identical'])(
  'final acceptance rejects superseded CI: %s',
  async (observation) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ted-stale-ci-'))
    let store = await openStore({ directory })
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      const task = await store.createTask({ title: 'Superseded final snapshot' })
      store.startRun({ id: 'lead', taskId: task.id, agent: 'codex', prompt: '', cwd: directory })
      let final = false,
        reads = 0,
        entered = () => {}
      const pending = new Promise<void>((resolve) => {
        entered = resolve
      })
      const createService = () =>
        createFailureCases({
          store,
          snapshot: async (_task, bindCi) => {
            bindCi()
            const id = `context-${reads++}`
            if (final && reads === 2) {
              entered()
              await gate
            }
            return {
              id,
              taskId: task.id,
              version: 2,
              capturedAt: new Date().toISOString(),
              fingerprint: 'context-A',
              repos: [],
              checks: 'checks',
              ci: 'CI-A',
            }
          },
          assertLead: () => {},
          drafts: () => [],
          onHold: async () => {},
          onInvalidated: async () => {},
          tell: async () => {},
        })
      let service = createService()
      const context = await service.capture(task, 'lead')
      const value = await service.record(task, 'lead', {
        source: { kind: 'finding', runId: 'lead', finding: 'Original' },
        evidence: 'Original evidence',
        contextId: context.id,
      })
      await service.assess(task, value.id, 'lead', {
        assessment: 'unrelated',
        recommendation: 'Accept A',
        choice: 'accepted',
      })
      const asked = await service.request(task, value.id, 'lead')
      final = true
      reads = 0
      const resolving = service.resolve(task, value.id, {
        requestId: asked.decisions.at(-1)?.commentId ?? '',
        resolution: 'accepted',
      })
      await pending
      await service.observeCi(task, 'CI-A')
      if (observation !== 'identical')
        await service.observeCi(task, observation === 'unavailable' ? null : 'CI-B')
      if (observation === 'restored') await service.observeCi(task, 'CI-A')
      expect(store.failures.get(value.id)?.resolutions).toHaveLength(0)
      release()
      if (observation === 'identical') await resolving
      else await expect(resolving).rejects.toMatchObject({ status: 409 })
      expect(store.failures.get(value.id)?.resolutions).toHaveLength(
        observation === 'identical' ? 1 : 0,
      )
      expect(store.failures.get(value.id)?.invalidations).toHaveLength(0)
      const history = store.failures.get(value.id)
      await store.persisted()
      await store.close()
      for (const file of await readdir(path.join(directory, 'ted')))
        if (file.startsWith('state')) await rm(path.join(directory, 'ted', file), { force: true })
      store = await openStore({ directory })
      expect(store.failures.get(value.id)).toEqual(history)
      service = createService()
      await service.observeCi(task, 'CI-A')
      if (observation !== 'identical') {
        await service.resolve(task, value.id, {
          requestId: asked.decisions.at(-1)?.commentId ?? '',
          resolution: 'accepted',
        })
      }
      expect(await service.obligations(task)).toMatchObject({
        satisfied: true,
        cases: [{ disposition: 'accepted', context: 'current' }],
      })
      await store.persisted()
    } finally {
      release()
      await store.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
  30000,
)
