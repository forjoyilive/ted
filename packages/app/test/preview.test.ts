import type { Task, TaskApp } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import { appStatusLine, previewChoice } from '../src/renderer/apps.ts'

const task = (preview?: { url: string; label: string }) =>
  ({
    repos: [
      {
        name: 'app',
        pullRequest: {
          number: 482,
          state: 'draft',
          ...(preview && { preview: { ...preview, source: 'deployment' } }),
        },
      },
    ],
  }) as unknown as Task

const app = (fields: Partial<TaskApp>): TaskApp => ({
  repo: 'app',
  name: 'Web',
  kind: 'web',
  state: 'stopped',
  ...fields,
})

describe('the sign-off Preview row', () => {
  test('a hosted preview comes first', () => {
    const hosted = task({ url: 'https://notebook-pr-482.vercel.app', label: 'Vercel' })
    const running = app({ state: 'running', url: 'http://localhost:5174' })
    expect(previewChoice(hosted, [running])).toMatchObject({
      kind: 'hosted',
      hosted: { repo: 'app', pullRequest: 482 },
    })
  })

  test('without one, the running Web App', () => {
    const api = app({ name: 'API', kind: 'command', state: 'running' })
    const running = app({ state: 'running', url: 'http://localhost:5174' })
    expect(previewChoice(task(), [api, running])).toEqual({ kind: 'local', app: running })
  })

  test('else Run, or Run again once the App has run', () => {
    expect(previewChoice(task(), [app({})])).toMatchObject({ kind: 'run', again: false })
    const crashed = app({ state: 'exited', exitCode: 1, startedAt: '2026-11-09T10:00:00Z' })
    expect(previewChoice(task(), [crashed])).toMatchObject({ kind: 'run', again: true })
  })

  test('nothing when the Task has no web App and no hosted preview', () => {
    expect(previewChoice(task(), [app({ kind: 'command' })])).toBeUndefined()
  })
})

describe('App status lines', () => {
  const now = Date.parse('2026-11-09T10:31:00Z')

  test('say where it runs, how long, or why it stopped', () => {
    expect(appStatusLine(app({ state: 'running', url: 'http://localhost:5174/' }), now)).toBe(
      'localhost:5174',
    )
    expect(
      appStatusLine(
        app({ kind: 'command', state: 'running', startedAt: '2026-11-09T10:00:00Z' }),
        now,
      ),
    ).toBe('Running · 31m')
    expect(appStatusLine(app({ state: 'exited', exitCode: 1 }), now)).toBe('Exited with code 1')
    expect(appStatusLine(app({ state: 'failed', problem: 'port 3000 is taken' }), now)).toBe(
      'Couldn’t start: port 3000 is taken',
    )
    expect(appStatusLine(app({ endedAt: '2026-11-09T10:11:00Z' }), now)).toBe('Stopped 20m ago')
    expect(appStatusLine(app({}), now)).toBe('Not running')
    expect(
      appStatusLine(app({ state: 'running', url: 'http://localhost:5174', removed: true }), now),
    ).toBe('Removed from settings · localhost:5174')
  })
})
