import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

const renderer = join(import.meta.dirname, '../src/renderer')

function moduleStylesheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return moduleStylesheets(path)
    return entry.name.endsWith('.module.css') ? [path] : []
  })
}

test('the renderer has CSS modules to check', () => {
  expect(moduleStylesheets(renderer).length).toBeGreaterThan(0)
})

test.each(moduleStylesheets(renderer).map((path) => [path.slice(renderer.length + 1), path]))(
  '%s is not empty',
  (_name, path) => {
    expect(readFileSync(path, 'utf8').trim()).not.toBe('')
  },
)
