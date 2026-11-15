import { readFileSync } from 'node:fs'
import path from 'node:path'

export const testFilePatterns = ['packages/*/test/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts']

type Read = Map<string, { electron: boolean; imports: string[] }>

function parsed(file: string, read: Read): { electron: boolean; imports: string[] } {
  let found = read.get(file)
  if (!found) {
    const source = readFileSync(file, 'utf8')
    found = {
      electron: /\b_electron\b|\bresolveElectron\s*\(\s*\)/.test(source),
      imports: [...source.matchAll(/from '(\.\.?\/[^']+\.tsx?)'/g)].map((match) =>
        path.resolve(path.dirname(file), match[1] ?? ''),
      ),
    }
    read.set(file, found)
  }
  return found
}

function launches(file: string, read: Read, seen = new Set<string>()): boolean {
  if (seen.has(file)) return false
  seen.add(file)
  const { electron, imports } = parsed(file, read)
  return electron || imports.some((next) => launches(next, read, seen))
}

export function launchesElectron(file: string): boolean {
  return launches(file, new Map())
}

export function electronFiles(
  files: readonly string[],
  locate: (file: string) => string,
): string[] {
  const read: Read = new Map()
  return files.filter((file) => launches(locate(file), read))
}

export function electronSandbox(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (env.CODEX_SANDBOX !== undefined) return 'Codex’s sandbox'
  return env.TED_SANDBOX === '1' && platform === 'darwin' ? 'TED’s sandbox' : undefined
}
