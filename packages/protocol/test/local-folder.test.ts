import { expect, test } from 'vitest'
import {
  type LocalFolderCheck,
  localFolderAction,
  localFolderAgentNote,
  localFolderCardText,
  localFolderLine,
  notedNotRepository,
  notRepositoryProblem,
  parseLocalFolderState,
  updateFailure,
} from '../src/local-folder.ts'

const folder = '/Users/me/Apps/ted'
const current: LocalFolderCheck = {
  checked: true,
  branch: 'main',
  against: 'main',
  main: 'main',
  head: '1a2b3c4d5e6f',
  target: '5d6e7f8a9b0c',
}
const behind: LocalFolderCheck = { ...current, behind: 168 }

test('Ted updates only a folder that is behind, on a branch, clean and without commits of its own', () => {
  expect(localFolderAction({ checked: false, problem: 'no network' }, folder)).toEqual({
    kind: 'run',
  })
  expect(localFolderAction({ ...current, ahead: 2 }, folder)).toEqual({
    kind: 'run',
  })
  expect(localFolderAction(behind, folder)).toEqual({ kind: 'update' })
  expect(localFolderAction({ ...behind, uncommitted: 1 }, folder)).toEqual({
    kind: 'hold',
    reason: '1 file has uncommitted changes',
    fix: `Commit or stash your changes in ${folder}, then ask the Agent to run it again.`,
  })
  expect(localFolderAction({ ...behind, ahead: 2, uncommitted: 3 }, folder)).toMatchObject({
    kind: 'hold',
    reason: 'it has 2 commits that aren’t on GitHub',
  })
  expect(localFolderAction({ checked: true, against: 'main', behind: 3 }, folder)).toMatchObject({
    kind: 'hold',
    reason: 'it isn’t on a branch',
  })
})

test('the card, the chat line and the Agent are told the same thing', () => {
  expect(localFolderCardText({ check: { ...behind, uncommitted: 3 } }, folder, 'ted')).toEqual({
    tone: 'warn',
    text: '168 commits behind main, and Ted can’t update it: 3 files have uncommitted changes.',
    fix: `Commit or stash your changes in ${folder}, then ask the Agent to run it again.`,
  })
  expect(
    localFolderCardText(
      {
        check: behind,
        updateFailed: 'git merge failed: fatal: Not possible to fast-forward, aborting.',
      },
      folder,
      'ted',
    ),
  ).toMatchObject({
    tone: 'warn',
    text: '168 commits behind main, and Ted can’t update it: the folder’s branch has moved away from GitHub’s, so it can’t be fast-forwarded.',
    detail: 'fatal: Not possible to fast-forward, aborting.',
  })
  expect(localFolderCardText({ check: { ...current } }, folder, 'ted')).toBe(undefined)
  expect(localFolderLine({ check: { ...current, ahead: 2, copyBehind: 20 } }, 'ted')).toEqual({
    tone: 'plain',
    text: 'Your local ted is 2 commits ahead of main. This chat’s copy is 20 commits behind main, so the Agent may have read older instructions.',
  })
  expect(
    localFolderLine(
      {
        check: { ...current, branch: 'fix-x', against: 'fix-x', behindMain: 40 },
      },
      'ted',
    ),
  ).toMatchObject({
    text: 'Your local ted is on fix-x, up to date with GitHub, 40 commits behind main.',
  })
  expect(
    localFolderLine({ check: { ...current, branch: 'fix-x', offGitHub: true } }, 'ted'),
  ).toMatchObject({ text: 'Your local ted is on fix-x, which isn’t on GitHub.' })
  expect(localFolderLine({ check: { checked: false, problem: 'no network' } }, 'ted')).toEqual({
    tone: 'plain',
    text: 'Ted couldn’t check your local ted against GitHub: no network.',
  })
  expect(localFolderAgentNote({ check: { ...behind, uncommitted: 3 } }, folder)).toBe(
    'The local folder is 168 commits behind main, and Ted couldn’t update it because 3 files have uncommitted changes. If the command failed, the older code there may be why, not your command. Don’t change the command; tell the user.',
  )
  expect(
    localFolderAgentNote(
      { check: behind, update: { from: behind.head ?? '', to: behind.target ?? '', commits: 168 } },
      folder,
    ),
  ).toBe(
    'Ted updated the local folder from 1a2b3c4 to 5d6e7f8 (it was 168 commits behind main) before running your command.',
  )
  expect(localFolderAgentNote({ check: { ...current } }, folder)).toBe(undefined)
})

test('a stored folder state is read back field by field and bad values are dropped', () => {
  const state = {
    check: { ...behind, uncommitted: 2, offGitHub: true },
    update: { from: 'a', to: 'b', commits: 3, dependencies: ['package.json'] },
    updateFailed: 'refused',
  }
  expect(parseLocalFolderState(JSON.parse(JSON.stringify(state)))).toEqual(state)
  expect(
    parseLocalFolderState({
      check: { checked: true, behind: -1, branch: 7 },
      update: { from: 'a' },
    }),
  ).toEqual({ check: { checked: true } })
  expect(parseLocalFolderState({ check: { behind: 3 } })).toBe(undefined)
  expect(parseLocalFolderState('nope')).toBe(undefined)
})

test('a failed update is told in plain words, with git’s own text kept as detail', () => {
  const untracked =
    'git merge failed: error: The following untracked working tree files would be overwritten by merge:\n\tclash.txt\nPlease move or remove them before you merge.\nAborting'
  expect(updateFailure(untracked)).toEqual({
    reason: 'untracked files in the folder would be overwritten (clash.txt)',
    detail:
      'error: The following untracked working tree files would be overwritten by merge: clash.txt Please move or remove them before you merge. Aborting',
  })
  expect(
    updateFailure(
      'git merge failed: error: Your local changes to the following files would be overwritten by merge:\n\ta.ts\n\tb.ts\n\tc.ts\n\td.ts\nAborting',
    ).reason,
  ).toBe('uncommitted changes in the folder would be overwritten (a.ts, b.ts, c.ts and 1 more)')
  expect(
    updateFailure(
      'git merge failed: error: The following untracked working tree files would be overwritten by merge:',
    ).reason,
  ).toBe('untracked files in the folder would be overwritten')
  expect(
    updateFailure("git merge failed: fatal: Unable to create '/x/.git/index.lock': File exists.")
      .reason,
  ).toBe('another git process is using the folder')
  expect(updateFailure('git fetch failed: fatal: unable to access').reason).toBe(
    'Ted couldn’t fetch from GitHub into the folder',
  )
  expect(updateFailure('git merge failed: something new')).toEqual({
    reason: 'git couldn’t update the folder',
    detail: 'something new',
  })
  expect(updateFailure('the folder changed while Ted fetched, so Ted left it alone')).toEqual({
    reason: 'the folder changed while Ted fetched, so Ted left it alone',
  })
  const state = { check: behind, updateFailed: untracked }
  expect(localFolderLine(state, 'ted')).toMatchObject({
    tone: 'warn',
    text: 'Your local ted is 168 commits behind main, and Ted’s update failed: untracked files in the folder would be overwritten (clash.txt).',
    detail: expect.stringContaining('clash.txt'),
  })
  expect(localFolderAgentNote(state, folder)).toContain(
    'Ted couldn’t update it because untracked files in the folder would be overwritten (clash.txt) (git said: error: The following untracked working tree files',
  )
})

test('a folder that isn’t a git repo is noted once per folder in a chat', () => {
  const notRepo = { check: { checked: false, problem: notRepositoryProblem } }
  const noNetwork = { check: { checked: false, problem: 'no network' } }
  expect(
    notedNotRepository([
      { id: 'a', folder: '/x', local: notRepo },
      { id: 'b', folder: '/y', local: notRepo },
      { id: 'c', folder: '/x', local: notRepo },
      { id: 'd', folder: '/x', local: noNetwork },
      { id: 'e', folder: '/x' },
    ]),
  ).toEqual(new Set(['c']))
  expect(localFolderLine(notRepo, 'ted')).toMatchObject({
    text: 'Ted couldn’t check your local ted against GitHub: the folder isn’t a git repository with a commit.',
  })
  expect(localFolderLine(notRepo, 'ted', true)).toBe(undefined)
  expect(localFolderLine(noNetwork, 'ted', true)).toMatchObject({
    text: 'Ted couldn’t check your local ted against GitHub: no network.',
  })
  expect(localFolderAgentNote(notRepo, folder)).toContain('isn’t a git repository')
  expect(localFolderAgentNote(notRepo, folder, true)).toBe(undefined)
  expect(localFolderAgentNote(noNetwork, folder, true)).toContain('no network')
})
