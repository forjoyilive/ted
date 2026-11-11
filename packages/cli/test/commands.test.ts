import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DaemonClient } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import { runCli } from '../src/cli.ts'
import { commands, helpText, parseInvocation, UsageError } from '../src/commands.ts'

const terminal = {}

describe('command definitions', () => {
  test('help is generated from every public command', () => {
    const help = helpText()
    for (const command of commands) {
      if (command.help) expect(help).toContain(command.help)
    }
    expect(help).toContain('ted outcome advance')
    expect(help).toContain('ted automation disable')
  })

  test.each([
    ['task', 'list', '--design', 'missing.json'],
    ['help', '--start'],
    ['peers', 'show', 'NB-1', '--offset', '1'],
    ['automation', 'list', '--prompt-file', 'missing.md'],
    ['task', 'repos', 'add', 'ted', '--yes'],
    ['task', 'create'],
    ['made-up'],
    ['failure', 'list', '--file', 'missing.json'],
    ['failure', 'record'],
    ['failure', 'ask'],
    ['task', 'made-up'],
    ['ask', '--round', 'round.json', '--close', '--summary', 'summary.md'],
    ['task', 'lead', 'NB-1', 'codex', '--default-model'],
  ])('refuses invalid invocation %j', (...args) => {
    expect(() => parseInvocation(args, terminal)).toThrow(UsageError)
  })

  test('ambiguous definitions fail instead of choosing the first match', () => {
    expect(() =>
      parseInvocation(['help'], terminal, [
        ...commands,
        ...commands.filter((entry) => entry.name === 'help'),
      ]),
    ).toThrow(UsageError)
  })

  test('flags before the command, repeated flags and -- keep their meaning', () => {
    const parsed = parseInvocation(
      ['--task', 'NB-1', 'comment', '--choice', 'Yes', '--choice', 'No', '--', '--start'],
      terminal,
    )
    expect(parsed.options.choice).toEqual(['Yes', 'No'])
    expect(parsed.options.task).toBe('NB-1')
    expect(parsed.args).toEqual(['--start'])
    expect(parsed.handler).toBe('comment')
  })

  test('status forms and ask forms are disjoint', () => {
    expect(parseInvocation(['status'], terminal).handler).toBe('status')
    expect(parseInvocation(['status', 'Reading'], terminal).handler).toBe('activity')
    expect(parseInvocation(['ask', '--round', 'round.json'], terminal).handler).toBe('round')
    expect(parseInvocation(['ask', '--close', '--summary', 'summary.md'], terminal).handler).toBe(
      'closeRound',
    )
    expect(parseInvocation(['ask', '--supersedes', 'old', 'Again?'], terminal).handler).toBe(
      'replaceRequest',
    )
  })

  test('context selects Automation and Planning handlers with Task precedence', () => {
    expect(parseInvocation(['comment', 'Hello'], { TED_AUTOMATION: 'run' }).handler).toBe(
      'automationComment',
    )
    expect(parseInvocation(['ask', '--round', 'round.json'], { TED_PLAN: 'run' }).handler).toBe(
      'planRound',
    )
    expect(
      parseInvocation(['task', 'propose', '--file', 'p.json'], { TED_PLAN: 'run' }).handler,
    ).toBe('planProposal')
    for (const env of [
      { TED_TASK: 'NB-1', TED_PLAN: 'run' },
      { TED_TASK: 'NB-1', TED_AUTOMATION: 'run' },
    ]) {
      expect(parseInvocation(['comment', 'Hello'], env).handler).toBe('comment')
    }
    expect(
      parseInvocation(['ask', '--round', 'r.json', '--task', 'NB-1'], { TED_PLAN: 'run' }).handler,
    ).toBe('round')
    expect(() =>
      parseInvocation(['comment', '--attach', 'a.md'], { TED_AUTOMATION: 'run' }),
    ).toThrow(UsageError)
  })

  test('table order has no effect on selection', () => {
    for (const args of [
      ['status'],
      ['status', 'Reading'],
      ['task', 'repos', 'set', 'ted'],
      ['ask', '--round', 'r.json'],
      ['peers', 'show', 'NB-1'],
    ]) {
      expect(parseInvocation(args, terminal, [...commands].reverse())).toEqual(
        parseInvocation(args, terminal),
      )
    }
  })
})

function preambleCommands(markdown: string): string[][] {
  return [...markdown.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1] ?? '')
    .filter((example) => example.startsWith('ted '))
    .map((example) => {
      const command = (example.split('<<')[0] ?? '').replace(/[[\]]/g, '')
      return (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [])
        .slice(1)
        .filter((word) => word !== '…')
        .map((word) => word.replace(/^["']|["']$/g, ''))
    })
}

function validatePreamble(markdown: string): void {
  const definitions = Object.assign({}, ...commands.map((entry) => entry.options))
  for (const words of preambleCommands(markdown)) {
    const positionals: string[] = []
    const flags: string[] = []
    for (let index = 0; index < words.length; index++) {
      const word = words[index] ?? ''
      if (!word.startsWith('--')) {
        positionals.push(word)
        continue
      }
      const name = word.slice(2).split('=')[0] ?? ''
      const definition = definitions[name]
      if (!definition) throw new UsageError(`unknown flag ${name}`)
      flags.push(name)
      if (
        definition.type === 'string' &&
        !word.includes('=') &&
        !words[index + 1]?.startsWith('--')
      )
        index++
    }
    const named = commands.filter((entry) =>
      entry.name.split(' ').every((part, index) => positionals[index] === part),
    )
    const depth = Math.max(0, ...named.map((entry) => entry.name.split(' ').length))
    const matches = named.filter(
      (entry) =>
        entry.name.split(' ').length === depth &&
        (entry.max === null || positionals.length - depth <= entry.max) &&
        flags.every((flag) => Object.hasOwn(entry.options, flag)),
    )
    if (matches.length === 0) throw new UsageError(`unknown command reference: ${words.join(' ')}`)
  }
}

describe('Task Lead preamble commands', () => {
  test('every example resolves through the command table', async () => {
    const text = await readFile(
      new URL('../../daemon/src/workflow/defaults/preamble.md', import.meta.url),
      'utf8',
    )
    const examples = preambleCommands(text)
    expect(examples.length).toBeGreaterThan(30)
    expect(examples).toContainEqual(['peers', 'show', '<Task>'])
    expect(examples).toContainEqual(['outcome', 'advance', '--design', '<file>'])
    expect(() => validatePreamble(text)).not.toThrow()
  })

  test.each([
    '`ted invented`',
    '`ted task invented`',
    '`ted task repos invented`',
    '`ted help --design <file>`',
  ])('rejects a nonexistent command or flag in %s', (text) => {
    expect(() => validatePreamble(text)).toThrow(UsageError)
  })
})

describe('importable CLI execution', () => {
  test('help and invalid input perform no daemon connection or stdin reads', async () => {
    let output = ''
    let errors = ''
    const runtime = {
      env: {},
      stdout: (text: string) => {
        output += text
      },
      stderr: (text: string) => {
        errors += text
      },
      connect: async () => {
        throw new Error('must not connect')
      },
      stdin: async () => {
        throw new Error('must not read stdin')
      },
    }
    expect(await runCli(['help'], runtime)).toBe(0)
    expect(output).toBe(`${helpText()}\n`)
    expect(await runCli(['task', 'list', '--design', 'missing.json'], runtime)).toBe(2)
    expect(await runCli(['comment', '--attach', 'missing.txt', '--skip'], runtime)).toBe(2)
    expect(errors).toContain('--design')
    expect(errors).toContain('--skip')
    expect(errors).not.toContain('ENOENT')
    expect(errors).not.toContain('must not')
    expect(process.exitCode).not.toBe(2)
  })

  test('concurrent invocations send Task, Automation and Planning requests independently', async () => {
    const requests: { url: string; authorization: string | undefined; body: unknown }[] = []
    const server = createServer(async (req, res) => {
      let text = ''
      for await (const chunk of req) text += chunk
      requests.push({
        url: req.url ?? '',
        authorization: req.headers.authorization,
        body: text === '' ? undefined : JSON.parse(text),
      })
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          id: 'request',
          kind: 'round',
          round: { number: 1 },
          proposal: { rows: [] },
        }),
      )
    })
    const home = await mkdtemp(path.join(tmpdir(), 'ted-command-'))
    try {
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('no port')
      const client = new DaemonClient({
        port: address.port,
        token: 'test-token',
        pid: process.pid,
        version: 'test',
      })
      const runtime = {
        home,
        stdout: () => {},
        stderr: () => {},
        connect: async <T>(_home: string, call: (client: DaemonClient) => Promise<T>) =>
          call(client),
      }
      const round = { title: 'Round', questions: [{ question: 'Why?', recommended: 'Because' }] }
      const file = path.join(home, 'round.json')
      await writeFile(file, JSON.stringify(round))
      const proposal = path.join(home, 'proposal.json')
      await writeFile(
        proposal,
        JSON.stringify({ title: 'Split', tasks: [{ title: 'One', scope: 'First' }] }),
      )
      expect(
        await Promise.all([
          runCli(['comment', 'Task note'], {
            ...runtime,
            env: { TED_TASK: 'NB-1', TED_AUTOMATION: 'auto' },
          }),
          runCli(['comment', 'Automation note'], { ...runtime, env: { TED_AUTOMATION: 'auto' } }),
          runCli(['ask', '--round', file], { ...runtime, env: { TED_PLAN: 'plan' } }),
          runCli(['ask', '--round', file, '--task', 'NB-2'], {
            ...runtime,
            env: { TED_PLAN: 'plan' },
          }),
          runCli(['task', 'propose', '--file', proposal], {
            ...runtime,
            env: { TED_PLAN: 'plan' },
          }),
        ]),
      ).toEqual([0, 0, 0, 0, 0])
      expect(requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ url: '/tasks/NB-1/comments', body: { body: 'Task note' } }),
          expect.objectContaining({
            url: '/automation-runs/comments',
            body: { body: 'Automation note' },
          }),
          expect.objectContaining({ url: '/plan-runs/requests', body: { round } }),
          expect.objectContaining({ url: '/tasks/NB-2/comments', body: { round } }),
          expect.objectContaining({
            url: '/plan-runs/requests',
            body: { proposal: { title: 'Split', tasks: [{ title: 'One', scope: 'First' }] } },
          }),
        ]),
      )
      expect(requests).toHaveLength(5)
      expect(requests.every((request) => request.authorization === 'Bearer test-token')).toBe(true)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('commands merged from the latest base', () => {
  test('registers export and Stage effort while keeping flags command-specific', () => {
    expect(
      parseInvocation(
        ['export', '--factory', 'NB', '--format', 'markdown', '--output', 'out.md'],
        {},
      ).handler,
    ).toBe('export')
    expect(parseInvocation(['task', 'lead', 'NB-1', 'codex', '--stage-effort'], {}).handler).toBe(
      'lead',
    )
    expect(() => parseInvocation(['help', '--output', 'out.md'], {})).toThrow(UsageError)
    expect(() => parseInvocation(['coordinator', 'tell', 'NB-1', '--approve'], {})).toThrow(
      UsageError,
    )
    expect(helpText()).toContain('ted coordinator resume')
    expect(helpText()).toContain('--recommended')
  })

  test('preserves Coordinator resume, decisions and round answers without reading stdin', async () => {
    const requests: { url: string; body: unknown }[] = []
    const server = createServer(async (req, res) => {
      let text = ''
      for await (const chunk of req) text += chunk
      requests.push({ url: req.url ?? '', body: text === '' ? undefined : JSON.parse(text) })
      res.setHeader('content-type', 'application/json')
      res.end('{}')
    })
    try {
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('no port')
      const client = new DaemonClient({
        port: address.port,
        token: 'test-token',
        pid: process.pid,
        version: 'test',
      })
      const runtime = {
        env: {},
        stdout: () => {},
        stderr: () => {},
        stdin: async () => {
          throw new Error('must not read stdin')
        },
        connect: async <T>(_home: string, call: (client: DaemonClient) => Promise<T>) =>
          call(client),
      }
      const common = ['NB-1', '--operation', 'op', '--version', 'version']
      for (const args of [
        ['resume', ...common, '--message', ' Continue '],
        [
          'answer',
          ...common,
          '--request',
          'request',
          '--approve',
          '--skip-rows',
          '[2]',
          '--start-unblocked',
        ],
        [
          'answer',
          ...common,
          '--request',
          'request',
          '--answers',
          '[{"answer":"Yes","note":"Agreed"}]',
        ],
        ['answer', ...common, '--request', 'request', '--recommended'],
      ])
        expect(await runCli(['coordinator', ...args], runtime)).toBe(0)
      expect(requests).toEqual([
        {
          url: '/coordinator/tasks/NB-1/resume',
          body: { operation: 'op', version: 'version', message: 'Continue' },
        },
        {
          url: '/coordinator/tasks/NB-1/answer',
          body: {
            operation: 'op',
            version: 'version',
            request: 'request',
            decision: 'approve',
            skipRows: [2],
            startUnblocked: true,
          },
        },
        {
          url: '/coordinator/tasks/NB-1/answer',
          body: {
            operation: 'op',
            version: 'version',
            request: 'request',
            answers: [{ answer: 'Yes', note: 'Agreed' }],
          },
        },
        {
          url: '/coordinator/tasks/NB-1/answer',
          body: { operation: 'op', version: 'version', request: 'request', recommended: true },
        },
      ])
      expect(
        await runCli(
          [
            'coordinator',
            'answer',
            ...common,
            '--request',
            'request',
            '--approve',
            '--request-changes',
          ],
          runtime,
        ),
      ).toBe(2)
      expect(
        await runCli(
          ['coordinator', 'answer', ...common, '--request', 'request', '--answers', 'invalid'],
          runtime,
        ),
      ).toBe(2)
      expect(
        await runCli(
          ['task', 'lead', 'NB-1', 'codex', '--stage-effort', '--effort', 'medium'],
          runtime,
        ),
      ).toBe(2)
      expect(requests).toHaveLength(4)
      for (const args of [
        ['peers', '--offset', '3'],
        ['peers', 'inbox', '--offset', '4'],
        ['coordinator', 'tasks', '--offset', '5'],
        ['coordinator', 'task', 'NB-1', '--offset', '6'],
        ['coordinator', 'move', ...common, '--after', 'NB-0', '--neighbours', '{"NB-0":"rank"}'],
      ])
        expect(await runCli(args, runtime)).toBe(0)
      expect(
        await runCli(['coordinator', 'tell', ...common], {
          ...runtime,
          stdin: async () => '  Keep going  ',
        }),
      ).toBe(0)
      expect(requests.slice(4)).toEqual([
        { url: '/peers?offset=3', body: undefined },
        { url: '/peers/inbox?offset=4', body: undefined },
        { url: '/coordinator/tasks?offset=5', body: undefined },
        { url: '/coordinator/tasks/NB-1?offset=6', body: undefined },
        {
          url: '/coordinator/tasks/NB-1/move',
          body: {
            operation: 'op',
            version: 'version',
            after: 'NB-0',
            neighbours: { 'NB-0': 'rank' },
          },
        },
        {
          url: '/coordinator/tasks/NB-1/tell',
          body: { operation: 'op', version: 'version', message: 'Keep going' },
        },
      ])
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })
})

describe('invalid command input is rejected before connecting', () => {
  test.each([
    ['peers', '--offset=-1'],
    ['peers', 'inbox', '--offset', 'NaN'],
    ['coordinator', 'tasks', '--offset=-1'],
    ['coordinator', 'task', 'NB-1', '--offset', '0.5'],
    ['coordinator', 'start', 'NB-1'],
    ['coordinator', 'move', 'NB-1', '--operation', 'op', '--version', 'v', '--neighbours', '{'],
    ['coordinator', 'tell', 'NB-1', '--operation', 'op'],
    ['coordinator', 'tell', 'NB-1', '--operation', 'op', '--version', 'v', '--message', ' '],
    ['coordinator', 'answer', 'NB-1', '--operation', 'op', '--version', 'v'],
    [
      'coordinator',
      'answer',
      'NB-1',
      '--operation',
      'op',
      '--version',
      'v',
      '--request',
      'r',
      '--choice',
      'A',
      '--choice',
      'B',
    ],
    [
      'coordinator',
      'answer',
      'NB-1',
      '--operation',
      'op',
      '--version',
      'v',
      '--request',
      'r',
      '--approve',
      '--request-changes',
    ],
    [
      'coordinator',
      'answer',
      'NB-1',
      '--operation',
      'op',
      '--version',
      'v',
      '--request',
      'r',
      '--answers',
      '{',
    ],
    [
      'coordinator',
      'answer',
      'NB-1',
      '--operation',
      'op',
      '--version',
      'v',
      '--request',
      'r',
      '--approve',
      '--skip-rows',
      '{',
    ],
    [
      'coordinator',
      'answer',
      'NB-1',
      '--operation',
      'op',
      '--version',
      'v',
      '--request',
      'r',
      '--request-changes',
      '--message',
      ' ',
    ],
    ['coordinator', 'resume', 'NB-1', '--operation', 'op'],
    ['peers', 'watch', '--timeout', '26'],
  ])('usage error without connecting: %j', async (...args) => {
    let connections = 0
    let error = ''
    const code = await runCli(args, {
      env: {},
      stdout: () => {},
      stderr: (text) => {
        error += text
      },
      stdin: async () => '',
      connect: async () => {
        connections++
        throw new Error('connector must not be reached')
      },
    })
    expect({ code, connections }).toEqual({ code: 2, connections: 0 })
    expect(error).not.toContain('connector must not be reached')
  })
})

describe('shared file parsers after CLI relocation', () => {
  test.each([
    {
      argv: ['ask', '--round'],
      context: { TED_TASK: 'NB-1' },
      error: 'a round must be an object',
    },
    {
      argv: ['ask', '--round'],
      context: { TED_PLAN: 'plan' },
      error: 'a round must be an object',
    },
    {
      argv: ['task', 'propose', '--file'],
      context: { TED_TASK: 'NB-1' },
      error: 'a proposal must be an object',
    },
    {
      argv: ['task', 'propose', '--file'],
      context: { TED_PLAN: 'plan' },
      error: 'a proposal must be an object',
    },
    {
      argv: ['outcome', 'advance', '--design'],
      context: { TED_TASK: 'NB-1' },
      error: 'the design file must hold a JSON object',
    },
  ])('rejects invalid $argv files in $context', async ({ argv, context, error }) => {
    const home = await mkdtemp(path.join(tmpdir(), 'ted-cli-parser-'))
    try {
      const file = path.join(home, 'invalid.json')
      await writeFile(file, '[]')
      let connections = 0
      let stderr = ''
      const code = await runCli([...argv, file], {
        home,
        env: context,
        stdout: () => {},
        stderr: (text) => {
          stderr += text
        },
        connect: async () => {
          connections++
          throw new Error('connector must not be reached')
        },
      })
      expect({ code, connections, stderr }).toEqual({
        code: 2,
        connections: 0,
        stderr: `ted: ${error}\n`,
      })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

test('failure input and missing Task are refused before connecting', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ted-failure-cli-'))
  let connected = false
  let errors = ''
  const runtime = {
    env: { TED_TASK: 'NB-1' },
    stderr: (text: string) => {
      errors += text
    },
    connect: async () => {
      connected = true
      throw new Error('must not connect')
    },
  }
  try {
    const file = path.join(dir, 'failure.json')
    await writeFile(
      file,
      JSON.stringify({
        source: { kind: 'finding', runId: 'reviewer', finding: 'Failure', category: 'other' },
        evidence: 'Evidence',
      }),
    )
    expect(await runCli(['failure', 'record', '--file', file], runtime)).toBe(2)
    expect(errors).toContain('category must be test, review or visual')
    errors = ''
    expect(await runCli(['failure', 'list'], { ...runtime, env: {} })).toBe(2)
    expect(errors).toContain('name the Task')
    expect(connected).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
