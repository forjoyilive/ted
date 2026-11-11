import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export async function createGhFixture(root: string) {
  const state = path.join(root, 'gh.json')
  const log = path.join(root, 'gh.jsonl')
  await writeFile(state, '{}')
  return {
    state,
    log,
    env: { TED_STUB_GH: state, TED_STUB_GH_LOG: log },
    async set(value: unknown) {
      await writeFile(`${state}.tmp`, JSON.stringify(value))
      await rename(`${state}.tmp`, state)
    },
    async calls(): Promise<{ args: string[] }[]> {
      return (await readFile(log, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const call = JSON.parse(line) as { args: string[] }
          return { args: call.args }
        })
    },
  }
}
