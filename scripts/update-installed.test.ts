import { describe, expect, test } from 'vitest'
import type { SlotHolder } from '../packages/protocol/src/slots.ts'
import {
  checksPlan,
  installFailedMessage,
  notificationScript,
  otherWorkingTasks,
  quitDecision,
  updateOptions,
} from './update-installed.ts'

describe('update-installed options', () => {
  test('reads --skip-checks and --yes, and the detached finish step’s arguments', () => {
    expect(updateOptions([])).toEqual({ skipChecks: false, yes: false })
    expect(updateOptions(['--skip-checks', '--yes'])).toEqual({ skipChecks: true, yes: true })
    expect(
      updateOptions(['--finish', '/x/Ted.app', '--commit', 'abc123', '--log', '/x/update.log']),
    ).toEqual({
      skipChecks: false,
      yes: false,
      finish: { built: '/x/Ted.app', commit: 'abc123', log: '/x/update.log' },
    })
  })

  test('refuses an unknown option', () => {
    expect(() => updateOptions(['--install'])).toThrow()
  })
})

describe('checks before an update', () => {
  test('--skip-checks skips them, a passed commit skips them, and otherwise they run', () => {
    expect(checksPlan({ skipChecks: true, passed: false, inRun: true })).toEqual({
      action: 'skip',
      reason: 'asked',
    })
    expect(checksPlan({ skipChecks: false, passed: true, inRun: true })).toEqual({
      action: 'skip',
      reason: 'passed',
    })
    expect(checksPlan({ skipChecks: false, passed: false, inRun: false })).toEqual({
      action: 'run',
    })
  })

  test('inside a Run, a commit that hasn’t passed stops the update with what to do', () => {
    expect(checksPlan({ skipChecks: false, passed: false, inRun: true })).toEqual({
      refusal: expect.stringMatching(/pnpm check --all.*--skip-checks/),
    })
  })
})

describe('working Tasks', () => {
  const task = (displayId: string, runs: number): SlotHolder => ({
    kind: 'task',
    taskId: `id-${displayId}`,
    displayId,
    title: displayId,
    factoryId: 'f',
    runs,
    subAgents: 0,
    settingUp: false,
  })

  test('counts Tasks with a working Run, leaving out the Task the command runs in', () => {
    const holders: SlotHolder[] = [
      task('TED-1', 1),
      task('TED-2', 0),
      task('TED-3', 2),
      { kind: 'coordinator', runId: 'r', factoryId: 'f', name: 'Coordinator', runs: 1 },
    ]
    expect(otherWorkingTasks(holders)).toEqual(['TED-1', 'TED-3'])
    expect(otherWorkingTasks(holders, 'TED-3')).toEqual(['TED-1'])
    expect(otherWorkingTasks(holders, 'id-TED-1')).toEqual(['TED-3'])
  })
})

describe('quitting Ted', () => {
  test('quits at once with nothing working or with --yes', () => {
    expect(quitDecision({ working: 0, yes: false, terminal: false })).toEqual({ action: 'quit' })
    expect(quitDecision({ working: 2, yes: true, terminal: false })).toEqual({ action: 'quit' })
    expect(quitDecision({ working: undefined, yes: true, terminal: false })).toEqual({
      action: 'quit',
    })
  })

  test('refuses without --yes when the working Tasks can’t be counted, even in a terminal', () => {
    for (const terminal of [true, false]) {
      expect(quitDecision({ working: undefined, yes: false, terminal })).toEqual({
        refusal: expect.stringMatching(/couldn’t be counted.*--yes/),
      })
    }
  })

  test('asks in a terminal, and refuses without one', () => {
    expect(quitDecision({ working: 1, yes: false, terminal: true })).toEqual({ action: 'ask' })
    expect(quitDecision({ working: 1, yes: false, terminal: false })).toEqual({
      refusal: expect.stringMatching(/^1 other Task is working.*--yes/),
    })
    expect(quitDecision({ working: 3, yes: false, terminal: false })).toEqual({
      refusal: expect.stringMatching(/^3 other Tasks are working/),
    })
  })
})

describe('a failed install', () => {
  test('never says to open Ted, and gives the commands that install the build again', () => {
    const message = installFailedMessage(
      '/x/ted-update/Ted.app',
      'Copy failed',
      '/x/ted-update.log',
    )
    expect(message).not.toMatch(/Open /)
    expect(message).toContain('pnpm update-installed again')
    expect(message).toContain("ditto '/x/ted-update/Ted.app' /Applications/Ted.app")
    expect(message).toContain('/x/ted-update.log')
  })
})

describe('notifications', () => {
  test('quote the text so a message can’t end the AppleScript string', () => {
    expect(notificationScript('Ted updated', 'say "hi"')).toBe(
      'display notification "say \\"hi\\"" with title "Ted updated"',
    )
    expect(notificationScript('Ted', 'a\nb')).toBe('display notification "a b" with title "Ted"')
  })
})
