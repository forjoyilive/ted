import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const rendererDir = fileURLToPath(new URL('../src/renderer', import.meta.url))
const tokensPath = path.join(rendererDir, 'styles/tokens.css')
const colour =
  /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\(|(?<![\w-])(?:white|black)(?![\w-])/i

async function sources(): Promise<{ file: string; text: string }[]> {
  const entries = await readdir(rendererDir, { recursive: true, withFileTypes: true })
  const files = entries
    .filter((e) => e.isFile() && /\.(css|tsx?|html)$/.test(e.name))
    .map((e) => path.join(e.parentPath, e.name))
  return Promise.all(files.map(async (file) => ({ file, text: await readFile(file, 'utf8') })))
}

async function tokens(): Promise<Map<string, string>> {
  const text = await readFile(tokensPath, 'utf8')
  return new Map(
    [...text.matchAll(/^\s*(--[a-z0-9-]+):\s*(.+);$/gm)].map((m) => [m[1] ?? '', m[2] ?? '']),
  )
}

describe('theme tokens', () => {
  test('no colour is written outside the token file', async () => {
    const offenders = (await sources())
      .filter(({ file }) => file !== tokensPath)
      .flatMap(({ file, text }) =>
        text
          .split('\n')
          .map((line, i) => ({ line, at: `${path.relative(rendererDir, file)}:${i + 1}` }))
          .filter(({ line }) => colour.test(line.replace(/var\(--[a-z0-9-]+\)/g, '')))
          .map(({ at, line }) => `${at} ${line.trim()}`),
      )

    expect(offenders).toEqual([])
  })

  test('every colour token has a light and a dark value', async () => {
    const colours = [...(await tokens())].filter(([, value]) => colour.test(value))

    expect(colours.length).toBeGreaterThan(80)
    for (const [name, value] of colours) {
      expect(value, name).toMatch(/^light-dark\(#[0-9a-f]{6,8}, #[0-9a-f]{6,8}\)$/)
    }
  })

  test('every token the renderer uses is defined', async () => {
    const defined = await tokens()
    const used = new Set(
      (await sources()).flatMap(({ text }) =>
        [...text.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1] ?? ''),
      ),
    )

    expect([...used].filter((name) => !defined.has(name))).toEqual([])
  })

  test('status colours, diff green and red, and the agent marks are tokens', async () => {
    const defined = await tokens()

    for (const name of [
      '--status-working-fg',
      '--status-waiting-fg',
      '--status-failed-fg',
      '--status-neutral-fg',
      '--diff-added-count',
      '--diff-removed-count',
      '--agent-mark',
      '--agent-mark-strong',
    ]) {
      expect(defined.has(name), name).toBe(true)
    }
  })
})
