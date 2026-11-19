import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { commands } from '../src/commands.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

interface NamedCommand {
  line: number
  command: string
}

function codeOf(markdown: string): { line: number; code: string }[] {
  const found: { line: number; code: string }[] = []
  let fenced = false
  for (const [index, text] of markdown.split('\n').entries()) {
    if (text.trimStart().startsWith('```')) {
      fenced = !fenced
      continue
    }
    if (fenced) found.push({ line: index + 1, code: text })
    else
      for (const span of text.matchAll(/`([^`]+)`/g))
        found.push({ line: index + 1, code: span[1] ?? '' })
  }
  return found
}

function namedCommands(markdown: string): NamedCommand[] {
  return codeOf(markdown).flatMap(({ line, code }) =>
    [...code.matchAll(/(?:^|[\s(;&|])ted((?:[ \t]+[a-z][a-z0-9-]*)+)/g)].map((match) => ({
      line,
      command: ['ted', ...(match[1] ?? '').trim().split(/[ \t]+/)].join(' '),
    })),
  )
}

function known(command: string): boolean {
  const words = command.split(' ').slice(1)
  return commands.some((entry) => {
    const name = entry.name.split(' ')
    const shorter = Math.min(name.length, words.length)
    return name.slice(0, shorter).every((word, index) => words[index] === word)
  })
}

async function agentDocs(): Promise<string[]> {
  const area = await readdir(path.join(root, 'docs/agents'))
  return [
    'AGENTS.md',
    ...area.filter((name) => name.endsWith('.md')).map((name) => `docs/agents/${name}`),
  ]
}

describe('commands named in the agent docs', () => {
  test('finds commands only in code and matches them against the command table', () => {
    const markdown = [
      'the ted task start rule is prose.',
      'Run `pnpm ted dev factory remove NB`, then `ted task start NB-1`.',
      '```sh',
      'TED_HOME="$PWD/home" pnpm ted coordinator',
      '```',
      'Use `ted run-app web` and `.ted/workflow.yaml`.',
      'Spaced out: `ted  dev\tfactory   remove`.',
    ].join('\n')

    const named = namedCommands(markdown)

    expect(named).toEqual([
      { line: 2, command: 'ted dev factory remove' },
      { line: 2, command: 'ted task start' },
      { line: 4, command: 'ted coordinator' },
      { line: 6, command: 'ted run-app web' },
      { line: 7, command: 'ted dev factory remove' },
    ])
    expect(named.filter((entry) => !known(entry.command)).map((entry) => entry.line)).toEqual([
      2, 7,
    ])
  })

  test('every ted command in AGENTS.md and docs/agents exists', async () => {
    const unknown: string[] = []
    for (const file of await agentDocs()) {
      const markdown = await readFile(path.join(root, file), 'utf8')
      for (const { line, command } of namedCommands(markdown)) {
        if (!known(command)) unknown.push(`${file}:${line} ${command}`)
      }
    }

    expect(unknown).toEqual([])
  })
})
