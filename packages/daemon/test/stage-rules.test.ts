import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const working = '(intake|clarify|design|work|validate|review|merge|cleanup)'
const stageRule = new RegExp(
  `(indexOf|includes|has)\\(\\s*'${working}'\\s*\\)|stage\\)? *[!=]== '${working}'`,
)

test('the daemon and CLI read Stage rules from @ted/protocol/stage, not from Stage ids', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const offenders: string[] = []
  for (const pkg of ['daemon', 'cli']) {
    const src = path.join(root, pkg, 'src')
    for (const file of await readdir(src, { recursive: true })) {
      if (!file.endsWith('.ts') || file.startsWith(`dev${path.sep}`)) continue
      const lines = (await readFile(path.join(src, file), 'utf8')).split('\n')
      lines.forEach((line, index) => {
        if (stageRule.test(line)) offenders.push(`${pkg}/src/${file}:${index + 1}`)
      })
    }
  }
  expect(offenders).toEqual([])
})
