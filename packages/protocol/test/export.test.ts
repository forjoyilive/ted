import { expect, test } from 'vitest'
import { type FactoryExport, formatExport } from '../src/export.ts'

test('JSON is versioned, complete and newline terminated; Markdown preserves hostile text in fences', () => {
  const snapshot: FactoryExport = {
    schemaVersion: 1,
    exportedAt: '2026-11-10T00:00:00Z',
    coverage: ['Retained data only'],
    factory: {
      id: 'f',
      key: 'NB',
      name: 'Widgets',
      defaultBranch: 'main',
      createdAt: 'now',
      repos: [],
    },
    tasks: [
      {
        id: 't',
        factoryId: 'f',
        number: 1,
        displayId: 'NB-1',
        title: '# Heading\nnext',
        description: 'Text\n```\n# injected\n````',
        priority: 'none',
        stage: 'backlog',
        blockedBy: [],
        attachments: [],
        createdAt: 'now',
        updatedAt: 'now',
        repos: [],
        descriptions: [{ version: 1, text: 'Original', at: 'now' }],
        briefs: [
          { taskId: 't', version: 1, text: 'Brief', stage: 'work', createdAt: 'now', runId: 'r' },
        ],
        comments: [
          {
            id: 'c',
            taskId: 't',
            kind: 'question',
            body: 'Proceed?',
            author: { kind: 'human' },
            createdAt: 'now',
            answer: { kind: 'answered', text: 'Yes', at: 'now' },
          },
        ],
        runs: [{ id: 'r', taskId: 't', agent: 'codex', state: 'working', startedAt: 'now' }],
      },
    ],
  }
  const task = snapshot.tasks[0]
  if (!task) throw new Error('No fixture Task')
  expect(() =>
    formatExport(
      { ...snapshot, tasks: [{ ...task, description: '` '.repeat(150_000) }] },
      'markdown',
    ),
  ).not.toThrow()
  const json = formatExport(snapshot, 'json')
  expect(json.endsWith('\n')).toBe(true)
  expect(JSON.parse(json)).toEqual(snapshot)
  const markdown = formatExport(snapshot, 'markdown')
  expect(markdown).toContain('`````\nText\n```\n# injected\n````\n`````')
  expect(markdown).toContain('## NB-1 · \\# Heading next')
  for (const value of [
    'Original',
    'Brief',
    'Proceed?',
    'Yes',
    'codex',
    'Retained data only',
    '"runId": "r"',
  ])
    expect(markdown).toContain(value)
  expect(formatExport({ ...snapshot, tasks: [] }, 'markdown')).toContain('No retained Tasks')
})
