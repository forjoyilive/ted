import type { TaskFiles } from '@ted/protocol'
import { expect, test } from 'vitest'
import { matchingFiles } from '../src/renderer/files.ts'

const files: TaskFiles = {
  taskId: 't1',
  repos: [
    {
      repo: 'web',
      paths: ['src/keymap.ts', 'docs/KEYMAP.ts', 'keymap.ts.old', 'README.md'],
      partial: false,
    },
    { repo: 'api', paths: ['README.md', 'src/keymap.ts'], partial: false },
  ],
}

test('quick open ranks exact names, searches paths and repo names and keeps duplicate paths distinct', () => {
  expect(matchingFiles(files, 'KEYMAP.ts').map((f) => f.path)).toEqual([
    'docs/KEYMAP.ts',
    'src/keymap.ts',
    'src/keymap.ts',
    'keymap.ts.old',
  ])
  expect(matchingFiles(files, 'web src/keymap')).toEqual([{ repo: 'web', path: 'src/keymap.ts' }])
  expect(matchingFiles(files, 'readme')).toHaveLength(2)
  expect(matchingFiles(files, 'not-here')).toEqual([])
  expect(matchingFiles(undefined, '')).toEqual([])
})

test('large result sets are bounded', () => {
  expect(
    matchingFiles(
      {
        taskId: 't',
        repos: [
          { repo: 'r', paths: Array.from({ length: 1000 }, (_, i) => `${i}.ts`), partial: true },
        ],
      },
      '',
    ),
  ).toHaveLength(200)
})
