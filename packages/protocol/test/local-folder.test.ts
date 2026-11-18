import { expect, test } from 'vitest'
import {
  type LocalFolderCheck,
  localFolderAction,
  localFolderAgentNote,
  localFolderCardText,
  localFolderLine,
  parseLocalFolderState,
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
      { check: behind, updateFailed: 'Not possible to fast-forward' },
      folder,
      'ted',
    ),
  ).toMatchObject({
    tone: 'warn',
    text: '168 commits behind main, and Ted can’t update it: Ted’s update failed: Not possible to fast-forward.',
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
