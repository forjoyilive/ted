import type { Factory, Task } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import { setupNotice } from '../src/renderer/setup-notice.ts'

const factory = { id: 'f', key: 'WD', name: 'Widgets', cloned: true } as Factory

const task = (id: string, fields: Partial<Task> = {}) =>
  ({ id, factoryId: 'f', stage: 'backlog', ...fields }) as Task

describe('setupNotice', () => {
  test('an open setup Task gives the open notice', () => {
    const setup = task('s', { setup: true, stage: 'clarify' })
    expect(setupNotice(factory, [setup, task('a')], task('a'))).toEqual({
      kind: 'open',
      task: setup,
    })
  })

  test('a Factory with settings, a merged setup Task or no setup Task gives none', () => {
    const open = task('s', { setup: true })
    expect(setupNotice({ ...factory, hasSettings: true }, [open], task('a'))).toBeUndefined()
    const merged = task('s', { setup: true, stage: 'done', merged: { at: '', pullRequests: [1] } })
    expect(setupNotice(factory, [merged], task('a'))).toBeUndefined()
    expect(setupNotice(factory, [task('a')], task('a'))).toBeUndefined()
  })

  test('with setup never finished, only the first Task started gets the never notice', () => {
    const archived = task('s', {
      setup: true,
      archived: { at: '', ended: { kind: 'never-started' } },
    })
    expect(setupNotice(factory, [archived, task('a')], task('a'))).toEqual({ kind: 'never' })
    const started = task('b', { stage: 'work' })
    expect(setupNotice(factory, [archived, started, task('a')], task('a'))).toBeUndefined()
  })

  test('the setup Task itself gets no notice', () => {
    const setup = task('s', { setup: true })
    expect(setupNotice(factory, [setup], setup)).toBeUndefined()
  })
})
