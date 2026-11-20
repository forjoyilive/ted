import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { parseJson } from '@ted/protocol/parse'
import { checkWorkflowPath, parseLibraryNames } from './check-path.ts'

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    'library-names': { type: 'string' },
    out: { type: 'string' },
  },
  strict: true,
})
const { target, out } = values
const library = values['library-names']
if (target === undefined || library === undefined || out === undefined) {
  console.error('usage: check-entry.ts --target <dir> --library-names <file> --out <file>')
  process.exit(2)
}

const libraryNames = parseLibraryNames(parseJson(await readFile(path.resolve(library), 'utf8')))
const problems = await checkWorkflowPath(path.resolve(target), { libraryNames })
const relative = problems.map((p) => ({ ...p, path: path.relative(process.cwd(), p.path) }))
await writeFile(path.resolve(out), `${JSON.stringify({ problems: relative })}\n`, { mode: 0o600 })
for (const p of relative)
  console.log(`${p.path}:${p.line}:${p.column}: ${p.severity}: ${p.message}`)
