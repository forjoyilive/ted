import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { markRelease, sampleFixtures } from '../scripts/stage.ts'

const editionSource = new URL('../../protocol/src/edition.ts', import.meta.url)
let dir: string | undefined

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

async function stagedEdition(code: string): Promise<string> {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-stage-'))
  const file = path.join(dir, 'packages', 'protocol', 'src', 'edition.js')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, code)
  return file
}

test('staged code is the release, not Ted Dev', async () => {
  const code = stripTypeScriptTypes(await readFile(editionSource, 'utf8'), { mode: 'strip' })
  const file = await stagedEdition(code)
  await markRelease(dir as string)
  const staged = (await import(pathToFileURL(file).href)) as typeof import('@ted/protocol')
  expect(staged.edition).toBe('release')
  expect(staged.identity()).toMatchObject({ name: 'Ted', homeFolder: '.ted' })
})

test('staging fails when it can’t find the edition line', async () => {
  await stagedEdition("export const edition = 'something else'\n")
  await expect(markRelease(dir as string)).rejects.toThrow(/edition/)
})

test('the release ships every stand-in the sample data uses, and what they import', async () => {
  const fixtures = path.resolve(import.meta.dirname, '../../daemon/test/fixtures')
  const daemonSrc = path.resolve(import.meta.dirname, '../../daemon/src')
  const shipped = new Set(sampleFixtures)
  const sources = [
    path.resolve(import.meta.dirname, '../../protocol/src/sample.ts'),
    path.join(daemonSrc, 'dev', 'fixtures.ts'),
    path.join(daemonSrc, 'dev', 'demo.ts'),
    path.join(daemonSrc, 'main.ts'),
  ]
  for (const file of sources) {
    for (const [, name] of (await readFile(file, 'utf8')).matchAll(/test\/fixtures\/([\w.-]+)'/g))
      expect(shipped, `${path.basename(file)} uses ${name}`).toContain(name)
  }
  for (const name of sampleFixtures) {
    const code = await readFile(path.join(fixtures, name), 'utf8')
    for (const [, specifier = ''] of code.matchAll(/from '(\.{1,2}\/[^']+)'/g)) {
      const target = path.resolve(fixtures, specifier)
      const local = path.dirname(target) === fixtures
      expect(
        local ? shipped.has(path.basename(target)) : target.startsWith(`${daemonSrc}${path.sep}`),
        `${name} imports ${specifier}`,
      ).toBe(true)
    }
  }
})
