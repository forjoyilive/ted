import { expect, test } from 'vitest'
import { parseAgentFileChanges } from '../src/agent-file-parsers.ts'
import {
  outsideArgv,
  outsideCommandWords,
  parseOutsideCommandAnswer,
  parseRunOutsideCommandRequest,
} from '../src/outside-command.ts'

test('an outside command is plain words with at most one argument slot', () => {
  expect(outsideCommandWords('pnpm release <version>')).toEqual({
    words: [
      { kind: 'text', text: 'pnpm' },
      { kind: 'text', text: 'release' },
      { kind: 'slot', name: 'version' },
    ],
  })
  expect(outsideCommandWords('./scripts/ship.sh --tag=v1 main')).toMatchObject({
    words: [{ text: './scripts/ship.sh' }, { text: '--tag=v1' }, { text: 'main' }],
  })
  for (const [command, problem] of [
    ['pnpm release <a> <b>', 'more than one argument slot'],
    ['<tool> run', 'can’t start with its argument slot'],
    ['echo hi; rm -rf ~', 'isn’t a plain word'],
    ['pnpm "$HOME"', 'isn’t a plain word'],
    ['pnpm `id`', 'isn’t a plain word'],
    ['pnpm a|b', 'isn’t a plain word'],
    ['pnpm a > out', 'isn’t a plain word'],
    ['pnpm ~/x', 'isn’t a plain word'],
    ['pnpm *', 'isn’t a plain word'],
    ['pnpm\nrelease', 'one line'],
    ['  ', 'is empty'],
  ]) {
    const result = outsideCommandWords(command ?? '')
    expect('problem' in result && result.problem).toContain(problem)
  }
})

test('the argument takes the slot’s place as one word and must be plain', () => {
  expect(outsideArgv('pnpm release <version>', '1.2.3')).toEqual({
    argv: ['pnpm', 'release', '1.2.3'],
  })
  expect(outsideArgv('pnpm release publish', undefined)).toEqual({
    argv: ['pnpm', 'release', 'publish'],
  })
  for (const [command, argument, problem] of [
    ['pnpm release <version>', undefined, 'needs an argument for <version>'],
    ['pnpm release publish', 'now', 'takes no argument'],
    ['pnpm release <version>', '1.2 3', 'isn’t a plain word'],
    ['pnpm release <version>', '$(id)', 'isn’t a plain word'],
    ['pnpm release <version>', '-rf', 'starts with a dash'],
    ['pnpm release <version>', 'x'.repeat(101), 'longer than 100'],
  ] as const) {
    const result = outsideArgv(command, argument)
    expect('problem' in result && result.problem).toContain(problem)
  }
})

test('requests and answers are parsed field by field', () => {
  expect(parseRunOutsideCommandRequest({ name: 'build', argument: '1.2.3' })).toEqual({
    name: 'build',
    argument: '1.2.3',
  })
  expect(parseRunOutsideCommandRequest({ name: 'publish' })).toEqual({ name: 'publish' })
  expect(() => parseRunOutsideCommandRequest({ name: 'Build!' })).toThrow('outside command names')
  expect(() => parseRunOutsideCommandRequest({ name: 'build', argument: 'a;b' })).toThrow(
    'the argument isn’t a plain word',
  )
  expect(() => parseRunOutsideCommandRequest({ name: 'build', argument: 7 })).toThrow(
    'argument must be text',
  )
  expect(parseOutsideCommandAnswer({ run: true, always: true })).toEqual({
    run: true,
    always: true,
  })
  expect(parseOutsideCommandAnswer({ run: false })).toEqual({ run: false, always: false })
  expect(() => parseOutsideCommandAnswer({ run: false, always: true })).toThrow(
    'Always allow needs Run',
  )
  expect(() => parseOutsideCommandAnswer({ run: 'yes' })).toThrow('run must be true or false')
})

test('Agent settings carry outside commands only when each is plain words', () => {
  expect(
    parseAgentFileChanges([
      {
        id: 'release',
        settings: {
          powers: ['run_outside'],
          outsideCommands: [{ name: 'build', command: 'pnpm release <version>' }],
        },
      },
    ]),
  ).toEqual([
    {
      id: 'release',
      settings: {
        powers: ['run_outside'],
        outsideCommands: [{ name: 'build', command: 'pnpm release <version>' }],
      },
    },
  ])
  expect(() =>
    parseAgentFileChanges([
      {
        id: 'release',
        settings: { outsideCommands: [{ name: 'build', command: 'pnpm release && rm -rf /' }] },
      },
    ]),
  ).toThrow('release: the outside command build has `&&`')
})
