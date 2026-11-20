import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { checkWorkflowPath } from './check-path.ts'

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    library: { type: 'string' },
    out: { type: 'string' },
  },
  strict: true,
})
const { target, library, out } = values
if (target === undefined || library === undefined || out === undefined) {
  console.error('usage: check-entry.ts --target <dir> --library <dir> --out <file>')
  process.exit(2)
}

const problems = await checkWorkflowPath(path.resolve(target), {
  libraryDir: path.resolve(library),
})
const relative = problems.map((p) => ({ ...p, path: path.relative(process.cwd(), p.path) }))
await writeFile(path.resolve(out), `${JSON.stringify({ problems: relative })}\n`, { mode: 0o600 })
for (const p of relative)
  console.log(`${p.path}:${p.line}:${p.column}: ${p.severity}: ${p.message}`)
