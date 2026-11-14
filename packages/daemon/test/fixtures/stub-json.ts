import { readFileSync } from 'node:fs'

// Tests rewrite these files with a plain write, which empties the file first. A read
// that lands in that moment waits for the whole file instead of seeing no settings.
export function readStubJson<T extends object>(file: string): Partial<T> {
  const started = Date.now()
  for (;;) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return {}
    }
    try {
      return JSON.parse(text) as Partial<T>
    } catch (error) {
      if (!(error instanceof SyntaxError) || Date.now() - started > 2_000) return {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
  }
}
