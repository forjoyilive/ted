import { expect, test } from 'vitest'
import { formatBytes, parseStorageFolderChange } from '../src/storage.ts'

test('formatBytes shows sizes under 1 GB in MB', () => {
  expect([512, 4_200, 150e6, 270e6, 999.4e6, 999.5e6, 2.4e9].map(formatBytes)).toEqual([
    '512 bytes',
    '4 KB',
    '150 MB',
    '270 MB',
    '999 MB',
    '1.0 GB',
    '2.4 GB',
  ])
})

test('folder changes accept a destination or the default', () => {
  expect(parseStorageFolderChange({ kind: 'backups', parent: '/Volumes/Archive' })).toEqual({
    kind: 'backups',
    parent: '/Volumes/Archive',
  })
  expect(parseStorageFolderChange({ kind: 'sandbox-caches', parent: null })).toEqual({
    kind: 'sandbox-caches',
    parent: null,
  })
  expect(() => parseStorageFolderChange({ kind: 'worktrees', parent: null })).toThrow('kind')
  expect(() => parseStorageFolderChange({ kind: 'backups', parent: 1 })).toThrow('parent')
})
