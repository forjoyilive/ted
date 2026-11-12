import { expect, test } from 'vitest'
import { fileIndex, references } from '../src/renderer/references.ts'

const found = (text: string) => references(text).flatMap((piece) => piece.reference ?? [])

test('finds commits, Task IDs and paths, and gives back the whole text', () => {
  const text =
    'Failure 646d82. On 195e5ce2, dev/demo.test.ts failed to advance GD-12. Stack: dev/scenarios.ts:308. See README.md.'
  const pieces = references(text)

  expect(pieces.map((piece) => piece.text).join('')).toBe(text)
  expect(found(text)).toEqual([
    { kind: 'commit', id: '195e5ce2' },
    { kind: 'file', path: 'dev/demo.test.ts' },
    { kind: 'task', id: 'GD-12' },
    { kind: 'file', path: 'dev/scenarios.ts', line: 308 },
    { kind: 'file', path: 'README.md' },
  ])
  expect(
    pieces.find((piece) => piece.reference?.kind === 'file' && piece.reference.line)?.text,
  ).toBe('dev/scenarios.ts:308')
})

test('leaves short references, plain words, numbers, times and web links alone', () => {
  expect(
    found(
      'Failure 646d82 at 09:53, e.g. version 1.5 of 16 tests. Done. See https://github.com/acme/widgets/commit/195e5ce2 and x195e5ce2y.',
    ),
  ).toEqual([])
  expect(found('abcdef1/notes.md')).toEqual([{ kind: 'file', path: 'abcdef1/notes.md' }])
  expect(found('See .github/workflows/ci.yml:1, .ted/workflow.yaml and .gitignore.')).toEqual([
    { kind: 'file', path: '.github/workflows/ci.yml', line: 1 },
    { kind: 'file', path: '.ted/workflow.yaml' },
    { kind: 'file', path: '.gitignore' },
  ])
  expect(found('../.ted/workflow.yaml')).toEqual([{ kind: 'file', path: '../.ted/workflow.yaml' }])
  expect(found(`A full hash: ${'a1'.repeat(20)}`)).toEqual([
    { kind: 'commit', id: 'a1'.repeat(20) },
  ])
})

test('a path matches a worktree file exactly, by repo, or by an unambiguous ending', () => {
  const file = fileIndex({
    taskId: 't1',
    repos: [
      {
        repo: 'web',
        paths: ['src/app/index.ts', 'src/lib/index.ts', 'README.md', 'src/a.ts'],
        partial: false,
      },
    ],
  })

  expect(file('README.md')).toEqual({ repo: 'web', path: 'README.md' })
  expect(file('./src/a.ts')).toEqual({ repo: 'web', path: 'src/a.ts' })
  expect(file('web/src/a.ts')).toEqual({ repo: 'web', path: 'src/a.ts' })
  expect(file('a.ts')).toEqual({ repo: 'web', path: 'src/a.ts' })
  expect(file('app/index.ts')).toEqual({ repo: 'web', path: 'src/app/index.ts' })
  expect(file('index.ts')).toBeUndefined()
  expect(file('node_modules/.cache/out.txt')).toBeUndefined()
  expect(file('../src/a.ts')).toBeUndefined()
  expect(file('../README.md')).toBeUndefined()
  expect(fileIndex(undefined)('README.md')).toBeUndefined()

  const two = fileIndex({
    taskId: 't1',
    repos: [
      { repo: 'web', paths: ['README.md'], partial: false },
      { repo: 'api', paths: ['README.md', 'main.go'], partial: false },
    ],
  })
  expect(two('README.md')).toBeUndefined()
  expect(two('api/README.md')).toEqual({ repo: 'api', path: 'README.md' })
  expect(two('main.go')).toEqual({ repo: 'api', path: 'main.go' })
})
