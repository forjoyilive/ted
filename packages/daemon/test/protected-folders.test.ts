import { describe, expect, test } from 'vitest'
import {
  namesHomeOrProtectedFolder,
  protectedPaths,
  refusesUnsandboxedCommand,
} from '../src/protected-folders.ts'

const home = '/Users/someone'

interface HookCall {
  tool_name: string
  tool_input: { command: string; dangerouslyDisableSandbox?: boolean }
}

describe('the home-folder guard', () => {
  test.each([
    'find ~ -maxdepth 4 -type d -name .ted',
    'find ~/ -name .env',
    'du -sh "$HOME"',
    'ls ${HOME}',
    'cd ~ && find . -name x',
    'ls ~/Documents',
    'cat "$HOME/Desktop/notes.txt"',
    'rg secret /Users/someone/Downloads',
    'ls /Users/someone',
    'ls ~/library/mobile\\ documents',
    'find ~/Library/Mobile\\ Documents',
    "find ~/Library -name '*.plist'",
    'ls ~/Library/',
    'ls "$HOME/Library/Application Support"',
    'find ~/* -name .env',
    'du -sh ~/Library/*',
    'ls /Users/someone/Library/Application\\ Support/*',
    'ls ~/D*',
  ])('refuses %s', (command) => {
    expect(namesHomeOrProtectedFolder(command, home)).toBe(true)
  })

  test.each([
    'pnpm vitest run packages/app/test/app.test.ts',
    'ls ~/.ted/worktrees/TED-1',
    'du -sh ~/Library/Caches/ananda-meditation',
    'cat /Users/someone/.ted/worktrees/TED-1/repo/package.json',
    'echo $HOMEBREW_PREFIX',
    'ls ~/DocumentsArchive',
    'ls ~/Library/Caches/*',
    'ls ~/.ted/worktrees/*',
    'cat ~/Library/Application\\ Support/Code/settings.json',
    'git log --oneline',
  ])('allows %s', (command) => {
    expect(namesHomeOrProtectedFolder(command, home)).toBe(false)
  })

  test('only an unsandboxed Bash call is refused', () => {
    const call = (input: HookCall) => refusesUnsandboxedCommand(JSON.stringify(input), home)
    const command = 'find ~ -name .env'
    expect(
      call({ tool_name: 'Bash', tool_input: { command, dangerouslyDisableSandbox: true } }),
    ).toBe(true)
    expect(call({ tool_name: 'Bash', tool_input: { command } })).toBe(false)
    expect(
      call({ tool_name: 'Bash', tool_input: { command: 'ls', dangerouslyDisableSandbox: true } }),
    ).toBe(false)
    expect(refusesUnsandboxedCommand('not json', home)).toBe(false)
  })

  test('the personal folders are absolute paths under the home folder', () => {
    expect(protectedPaths(home)).toEqual(
      expect.arrayContaining([
        '/Users/someone/Desktop',
        '/Users/someone/Documents',
        '/Users/someone/Downloads',
        '/Users/someone/Library/Mobile Documents',
      ]),
    )
  })
})
