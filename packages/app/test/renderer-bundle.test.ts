import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test } from 'vitest'

const appDir = fileURLToPath(new URL('..', import.meta.url))

test('the renderer bundle pulls in no Node module', async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'ted-renderer-'))
  try {
    await build({
      configFile: path.join(appDir, 'vite.config.ts'),
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true },
    })
    const files = (await readdir(outDir, { recursive: true })).filter((f) => f.endsWith('.js'))
    expect(files.length).toBeGreaterThan(0)
    const found = new Set<string>()
    for (const file of files) {
      const text = await readFile(path.join(outDir, file), 'utf8')
      for (const match of text.matchAll(
        /__vite-browser-external(?::[\w:/-]+)?|(?<=["'`])node:[a-z_/]+(?=["'`])/g,
      )) {
        found.add(match[0])
      }
    }
    expect([...found]).toEqual([])
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
}, 120_000)
